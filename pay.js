/* ---------------------------------------------------------------------------
   KAIRO 1980 — paying, in the page
   ---------------------------------------------------------------------------
   Fetched on demand by order.js the moment a guest chooses to pay online, the
   same way qr.js is fetched only when the WhatsApp fallback is opened. A
   visitor who reads the menu and leaves still makes no third-party request.

   Four methods, one provider. Three of the four need no PayPal account:

     Apple Pay    the sheet, Face ID, done
     Google Pay   the sheet
     Card         PayPal's guest checkout — no account, no sign-in
     PayPal       the one method where the guest does sign in

   Nothing here decides what a guest can use. The SDK does: Apple Pay and
   Google Pay depend on PayPal having enabled Advanced Checkout for the
   merchant AND on the device having the wallet, and both answers live in the
   browser. Every method below is drawn only after the SDK says it is eligible,
   and silently skipped otherwise — so the day PayPal approves the account, the
   wallets simply appear. No deploy, no edit.

   Every string is passed in from order.js. The three dictionaries live there,
   in one table, and this file never invents copy of its own.
--------------------------------------------------------------------------- */

(function () {
  'use strict';

  var STORE_KEY = 'kairo.payment.v1';
  var GOOGLE_PAY_SDK = 'https://pay.google.com/gp/p/js/pay.js';
  var BRAND = 'KAIRO 1980';

  var config = null;      // what /api/payments/config answered
  var scripts = {};       // src -> Promise, so each script loads exactly once

  /* --- talking to our own server ----------------------------------------- */

  function api(path, options) {
    var opts = options || {};
    return fetch(path, {
      method: opts.method || 'GET',
      headers: opts.body ? { 'Content-Type': 'application/json' } : undefined,
      body: opts.body ? JSON.stringify(opts.body) : undefined,
      credentials: 'same-origin'
    }).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (data) {
        if (!res.ok) {
          var err = new Error((data.error && data.error.message) || 'request failed');
          err.code = (data.error && data.error.code) || 'http_' + res.status;
          err.data = data;
          throw err;
        }
        return data;
      });
    });
  }

  function available() {
    if (config) return Promise.resolve(config);
    return api('/api/payments/config').then(function (data) {
      config = data;
      return config;
    }).catch(function () {
      config = { online: false, methods: [], keys: {} };
      return config;
    });
  }

  function loadScript(src) {
    if (scripts[src]) return scripts[src];
    scripts[src] = new Promise(function (resolve, reject) {
      var script = document.createElement('script');
      script.src = src;
      script.async = true;
      script.onload = resolve;
      script.onerror = function () { reject(new Error('script failed: ' + src)); };
      document.head.appendChild(script);
    });
    // A failed load must not poison the next attempt: the guest may simply be
    // on a train.
    scripts[src].catch(function () { delete scripts[src]; });
    return scripts[src];
  }

  /* --- remembering a payment across a reload ------------------------------
     A guest who refreshes, backs out or loses the tab must never be asked to
     pay twice, and must never be told an order failed when the money was
     taken. The id is kept here; the SERVER holds what actually happened. */

  function remember(record) {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(record)); } catch (e) { /* private mode */ }
  }

  /* What the device keeps, and for how long (DP-24-02). For the first hour the
     order the payment is for (the server's own lines and figures, no name, no
     phone, no address), so a reload can hand it over. After that only the
     reference, the amount and the id, for a day: enough to tell the guest
     "this payment exists, do not pay again" and to ask the server what became
     of it, never enough to hand an order over from. */
  var DETAIL_MS = 3600000;
  var REFERENCE_MS = 24 * 3600000;

  function remembered() {
    try {
      var raw = localStorage.getItem(STORE_KEY);
      if (!raw) return null;
      var record = JSON.parse(raw);
      if (!record || !record.id) { localStorage.removeItem(STORE_KEY); return null; }
      var age = Date.now() - (record.at || 0);
      if (age > REFERENCE_MS) { localStorage.removeItem(STORE_KEY); return null; }
      if (age > DETAIL_MS && !record.expired) {
        record = { id: record.id, reference: record.reference, amount: record.amount,
                   at: record.at, expired: true };
        remember(record);
      }
      return record;
    } catch (e) { return null; }
  }

  /* The handover screen was shown; only the server's answer is outstanding. A
     reload then retries the handover quietly instead of showing it again. */
  function markHandedOver(id) {
    var record = remembered();
    if (!record || record.id !== id) return;
    record.handedOver = true;
    remember(record);
  }

  /* Only the record of THIS payment. A delayed answer about an older payment
     must never wipe the record of a newer one (DP-24-02). */
  function forget(id) {
    try {
      var raw = localStorage.getItem(STORE_KEY);
      var record = raw ? JSON.parse(raw) : null;
      if (record && record.id !== id) return;
      localStorage.removeItem(STORE_KEY);
    } catch (e) { /* nothing to do */ }
  }

  function statusOf(id) {
    return api('/api/payments/' + encodeURIComponent(id)).then(function (data) {
      return data && data.payment;
    });
  }

  /* What the server says a payment means for the money (DP-25-01): 'money',
     'none' (the provider established that nothing was or will be taken),
     'open' (it may still be taken) or 'manual' (a person must look). An answer
     that does not say, or does not name a payment, is 'unknown', and is treated
     as open: nothing is let go and nothing is offered instead. */
  var MONEY = ['money', 'none', 'open', 'manual'];
  function moneyOf(payment) {
    if (!payment || typeof payment !== 'object' || !payment.id || !payment.status) return 'unknown';
    return MONEY.indexOf(payment.money) !== -1 ? payment.money : 'unknown';
  }

  /* --- the three steps every method shares --------------------------------
     Create the payment on our server (which prices it), let the guest approve
     it however their method approves things, then ask our server what became
     of it. Only the middle step differs between a wallet and a button. */

  /* One payment at a time on this device (DP-25-02). A second start while one is
     being created is ignored; one while an earlier payment is still remembered
     is refused, and the page is told so: it shows that payment, never a second
     one over it. */
  var creating = false;
  var creation = null;     // settles when the payment being created has an answer
  var abandoned = false;   // the page sent something else meanwhile (DP-26-02)
  function refusal(code) { var err = new Error(code); err.code = code; return err; }

  /* The page is about to send something while a payment is being created: it
     waits for the answer (holdNew returns a promise, or null when nothing is
     being created), and the payment, once it exists, is not continued to the
     provider's window. It is cancelled at the server instead; if the provider
     confirms it unapproved it is forgotten, otherwise it stays remembered and
     is shown by its reference. */
  function holdNew() {
    if (!creation) return null;
    if (creating) abandoned = true;
    var held = creation;
    return held.then(function () {}, function () {}).then(function () {
      if (creation === held) creation = null;
    });
  }

  function createPayment(spec, method) {
    if (creating) return Promise.reject(refusal('busy'));
    if (remembered()) return Promise.reject(refusal('unsettled'));
    creating = true;
    abandoned = false;
    spec.onState('paying');
    var body = {};
    Object.keys(spec.order).forEach(function (k) { body[k] = spec.order[k]; });
    body.method = method;

    // Held until the whole start is over, a cancel after it included.
    var chain = api('/api/payments', { method: 'POST', body: body }).then(function (payment) {
      /* The order the payment is for, kept beside it on this device so a reload
         hands over THAT order, not whatever the page shows by then. No name, no
         phone, no address: only what the server matches the payment by.

         Its lines and figures are the SERVER's, from this answer (DP-24-02):
         what the payment was priced at, not the page's own arithmetic. Kept
         only if they are a whole order (sound lines that add up to the amount)
         and the very basket that was sent; compared field by field with what
         the page showed, and marked if any figure differs. Otherwise only the
         reference is kept, and the payment is told by it alone. */
      var o = spec.order || {};
      var b = payment.breakdown || {};
      var order = { items: o.items, type: o.type, business: !!o.business,
                    postcode: o.postcode, town: o.town || null,
                    time: o.time || null, when: o.when || null,
                    lines: payment.lines, subtotal: b.subtotal, discount: b.discount,
                    fee: b.fee, total: payment.amount };
      var record = { id: payment.id, reference: payment.reference, amount: payment.amount, at: Date.now() };
      var agreed = wholeOrder(order, payment.amount) && sameFigures(order, spec.snapshot);
      if (agreed) record.order = order;
      remember(record);
      creating = false;
      /* The guest is never asked to approve figures other than the ones shown
         (DP-25-02): a server answer that is not a whole order, or one that
         prices it differently line by line (the same total, another fee or
         discount), stops here, before the provider's window opens. The payment
         is cancelled at the server, which forgets it once the provider confirms
         it unapproved, and the page is reloaded to show the server's figures. */
      if (!agreed || abandoned) {
        var why = abandoned ? 'abandoned' : 'total_changed';
        abandoned = false;
        return cancel(payment.id).then(function () { throw refusal(why); },
                                       function () { throw refusal(why); });
      }
      spec.onState('created', { payment: payment });
      return payment;
    }, function (err) { creating = false; throw err; });
    creation = chain;
    return chain;
  }

  /* A start that did not happen, said to the page. A second click is silent; a
     payment already held is shown by the page; anything else is a failure
     before any money could move. */
  function refused(spec, err) {
    var code = err && err.code;
    if (code === 'busy' || code === 'abandoned') return;
    if (code === 'unsettled') { spec.onState('unsettled'); return; }
    spec.onState('failed', { code: code });
  }

  /* A complete, self-consistent order: non-empty lines with a dish, a whole
     positive quantity and whole cents each, no dish twice, the lines summing to
     the subtotal, the subtotal less the discount plus the fee being the total,
     the total being the payment's amount, and the lines being exactly the
     basket. Anything else is not an order this page may tell. */
  function wholeOrder(o, amount) {
    var whole = function (n, min) { return Number.isSafeInteger(n) && n >= min; };
    if (!o || (o.type !== 'delivery' && o.type !== 'pickup')) return false;
    if (typeof o.business !== 'boolean') return false;
    if (o.type === 'delivery' && !/^[0-9]{5}$/.test(String(o.postcode || ''))) return false;
    if (!Array.isArray(o.lines) || !o.lines.length) return false;
    if (!whole(o.subtotal, 0) || !whole(o.discount, 0) || !whole(o.fee, 0) || !whole(o.total, 1)) return false;
    if (o.discount > o.subtotal || o.subtotal - o.discount + o.fee !== o.total || o.total !== amount) return false;
    var seen = {};
    var sum = 0;
    for (var i = 0; i < o.lines.length; i++) {
      var l = o.lines[i];
      if (!l || typeof l.id !== 'string' || !l.id || seen[l.id] || typeof l.name !== 'string' || !l.name.trim()) return false;
      if (!whole(l.qty, 1) || !whole(l.amount, 0)) return false;
      seen[l.id] = l.qty;
      sum += l.amount;
    }
    if (!Number.isSafeInteger(sum) || sum !== o.subtotal) return false;
    var items = o.items || {};
    var keys = Object.keys(items).filter(function (k) { return Number(items[k]) > 0; });
    if (keys.length !== o.lines.length) return false;
    return keys.every(function (k) { return seen[k] === Number(items[k]); });
  }

  function sameFigures(o, shown) {
    if (!shown) return false;
    var keys = ['subtotal', 'discount', 'fee', 'total'];
    if (keys.some(function (k) { return o[k] !== shown[k]; })) return false;
    if (!Array.isArray(shown.lines) || shown.lines.length !== o.lines.length) return false;
    var byId = {};
    shown.lines.forEach(function (l) { byId[l.id] = l; });
    return o.lines.every(function (l) {
      var s = byId[l.id];
      return !!s && s.qty === l.qty && s.amount === l.amount;
    });
  }

  /* What became of the capture, from the server. An answer that never came
     (a dropped connection, a timeout, a server error with no payment in it) is
     NOT a failure: the capture may have succeeded and its answer been lost, and
     the webhook settles it later. So the payment is asked about, and until the
     server names a final state the guest is told "not yet confirmed, do not
     pay again", never "nothing was charged" (DP-24-01). */
  function settle(payment, spec, errorCode) {
    return api('/api/payments/' + encodeURIComponent(payment.id) + '/capture', { method: 'POST' })
      .then(function (data) { report(data.payment, spec, errorCode, payment); })
      .catch(function (err) {
        if (err.data && err.data.payment) { report(err.data.payment, spec, err.data.error, payment); return; }
        ask(payment, spec, errorCode);
      });
  }

  /* Ask the server what this payment is now; an unanswered question is an
     unknown, not a failure. */
  function ask(payment, spec, errorCode) {
    return statusOf(payment.id)
      .then(function (now) { report(now, spec, errorCode, payment); })
      .catch(function () { spec.onState('uncertain', { payment: payment }); });
  }

  /* Only a state the server named settles anything. Failed and cancelled are
     final with no money taken: the record goes, and the guest may pay another
     way. Captured and pending are money: handed over. Anything else (created,
     approved, an unreadable answer) may still become money, so the record is
     kept and the guest is told not to pay again. */
  function report(payment, spec, errorCode, known) {
    var money = moneyOf(payment);
    if (money === 'unknown' || (known && payment.id !== known.id)) {
      spec.onState('uncertain', { payment: known || payment }); return;
    }
    // Kept, not forgotten: the page forgets it once the server has the order
    // (or has flagged it for a person). Until then a reload can still hand it
    // over (DP-23-02).
    if (money === 'money') { spec.onState(payment.status === 'captured' ? 'paid' : 'pending', { payment: payment }); return; }
    if (money === 'manual') { spec.onState('manual', { payment: payment }); return; }
    if (money === 'none') {
      forget(payment.id);
      if (payment.status === 'cancelled') spec.onState('cancelled', { payment: payment });
      else spec.onState('failed', { payment: payment, code: errorCode || payment.failureCode });
      return;
    }
    spec.onState('uncertain', { payment: payment });
  }

  /* The guest closed the sheet. Nothing is called cancelled until the server
     says so: a capture that landed first is money, and is handed over. */
  function cancelled(payment, spec) {
    if (!payment) { spec.onState('cancelled'); return; }
    return api('/api/payments/' + encodeURIComponent(payment.id) + '/cancel', { method: 'POST' })
      .then(function (data) { report(data.payment, spec, null, payment); })
      .catch(function () { ask(payment, spec); });
  }

  /* From the page, for a payment it is unsure of: cancel it at the server and
     go by what the server answers. */
  function cancel(id) {
    return api('/api/payments/' + encodeURIComponent(id) + '/cancel', { method: 'POST' })
      .then(function (data) {
        var payment = data && data.payment;
        if (moneyOf(payment) === 'none' && payment.id === id) forget(id);
        return payment || null;
      });
  }

  function slot(spec, method) {
    var el = document.createElement('div');
    el.className = 'pay-method pay-method-' + method;
    spec.host.appendChild(el);
    return el;
  }

  /* --- the PayPal SDK -----------------------------------------------------
     Asked for every component the account might be able to use. Requesting
     applepay/googlepay on an account without Advanced Checkout is harmless:
     the component loads and simply reports that it is not eligible. */

  function loadSdk() {
    var key = config.keys.paypal && config.keys.paypal.clientId;
    if (!key) return Promise.reject(new Error('no client id'));

    var host = config.environment === 'live'
      ? 'https://www.paypal.com/sdk/js'
      : 'https://www.sandbox.paypal.com/sdk/js';

    var components = ['buttons'];
    if (config.methods.indexOf('applepay') !== -1) components.push('applepay');
    if (config.methods.indexOf('googlepay') !== -1) components.push('googlepay');

    var params = [
      'client-id=' + encodeURIComponent(key),
      'currency=' + encodeURIComponent(config.currency || 'EUR'),
      'intent=capture',
      'components=' + components.join(','),
      // The card button IS the no-account path. Never disable it.
      'enable-funding=card',
      // Methods this restaurant does not settle in. Offering a guest a
      // financing plan for a plate of koshari helps nobody.
      'disable-funding=credit,paylater'
    ];

    return loadScript(host + '?' + params.join('&')).then(function () {
      if (!window.paypal) throw new Error('sdk did not initialise');
      return window.paypal;
    });
  }

  /* --- Apple Pay ----------------------------------------------------------
     Not a PayPal button: the browser draws the sheet natively and PayPal only
     validates the merchant and confirms the order behind it. Which is exactly
     why the guest never sees PayPal and needs no account with them. */

  function mountApplePay(paypal, spec) {
    if (!window.ApplePaySession || !window.ApplePaySession.canMakePayments()) {
      return Promise.resolve(false);
    }
    if (!paypal.Applepay) return Promise.resolve(false);

    var applepay = paypal.Applepay();
    return applepay.config().then(function (cfg) {
      if (!cfg || !cfg.isEligible) return false;

      var host = slot(spec, 'applepay');
      var button = document.createElement('button');
      button.type = 'button';
      button.className = 'pay-native pay-native-apple';
      button.setAttribute('aria-label', spec.labels.payNow);
      host.appendChild(button);

      button.addEventListener('click', function () {
        var payment = null;
        var session = new window.ApplePaySession(4, {
          countryCode: cfg.countryCode,
          currencyCode: config.currency || 'EUR',
          merchantCapabilities: cfg.merchantCapabilities,
          supportedNetworks: cfg.supportedNetworks,
          requiredBillingContactFields: ['postalAddress'],
          total: { label: BRAND, amount: (spec.amount / 100).toFixed(2), type: 'final' }
        });

        session.onvalidatemerchant = function (event) {
          applepay.validateMerchant({
            validationUrl: event.validationURL,
            displayName: BRAND
          }).then(function (payload) {
            session.completeMerchantValidation(payload.merchantSession);
          }).catch(function () {
            session.abort();
            spec.onState('failed', { code: 'merchant_validation' });
          });
        };

        session.onpaymentauthorized = function (event) {
          createPayment(spec, 'applepay').then(function (created) {
            payment = created;
            return applepay.confirmOrder({
              orderId: created.providerOrderId,
              token: event.payment.token,
              billingContact: event.payment.billingContact
            });
          }).then(function () {
            session.completePayment(window.ApplePaySession.STATUS_SUCCESS);
            return settle(payment, spec);
          }).catch(function (err) {
            session.completePayment(window.ApplePaySession.STATUS_FAILURE);
            if (payment) ask(payment, spec, 'declined');
            else refused(spec, err);
          });
        };

        session.oncancel = function () { cancelled(payment, spec); };
        session.begin();
      });

      return true;
    }).catch(function () { return false; });
  }

  /* --- Google Pay ---------------------------------------------------------
     Same shape: Google draws the sheet, PayPal confirms the order behind it.
     Google's own script is loaded only once PayPal has said the account is
     eligible, so an unapproved account fetches nothing from Google at all. */

  function mountGooglePay(paypal, spec) {
    if (!paypal.Googlepay) return Promise.resolve(false);

    var googlepay = paypal.Googlepay();
    return googlepay.config().then(function (cfg) {
      if (!cfg || !cfg.isEligible) return false;
      return loadScript(GOOGLE_PAY_SDK).then(function () {
        if (!window.google || !window.google.payments) return false;

        var client = new window.google.payments.api.PaymentsClient({
          environment: config.environment === 'live' ? 'PRODUCTION' : 'TEST'
        });

        return client.isReadyToPay({
          apiVersion: cfg.apiVersion,
          apiVersionMinor: cfg.apiVersionMinor,
          allowedPaymentMethods: cfg.allowedPaymentMethods
        }).then(function (ready) {
          if (!ready || !ready.result) return false;

          var host = slot(spec, 'googlepay');
          host.appendChild(client.createButton({
            buttonType: 'pay',
            buttonSizeMode: 'fill',
            onClick: function () { pay(client, cfg, spec); }
          }));
          return true;
        });
      });
    }).catch(function () { return false; });
  }

  function pay(client, cfg, spec) {
    var payment = null;
    client.loadPaymentData({
      apiVersion: cfg.apiVersion,
      apiVersionMinor: cfg.apiVersionMinor,
      allowedPaymentMethods: cfg.allowedPaymentMethods,
      merchantInfo: cfg.merchantInfo,
      transactionInfo: {
        countryCode: cfg.countryCode,
        currencyCode: config.currency || 'EUR',
        totalPriceStatus: 'FINAL',
        totalPrice: (spec.amount / 100).toFixed(2)
      }
    }).then(function (data) {
      return createPayment(spec, 'googlepay').then(function (created) {
        payment = created;
        return window.paypal.Googlepay().confirmOrder({
          orderId: created.providerOrderId,
          paymentMethodData: data.paymentMethodData
        });
      });
    }).then(function () {
      return settle(payment, spec);
    }).catch(function (err) {
      // Google reports a closed sheet as an error; it is a cancellation.
      if (err && (err.statusCode === 'CANCELED' || err.code === 'CANCELED')) {
        cancelled(payment, spec);
        return;
      }
      if (payment) ask(payment, spec, 'declined');
      else refused(spec, err);
    });
  }

  /* --- card and PayPal ----------------------------------------------------
     Both are PayPal Buttons; only the funding source differs. The card button
     opens PayPal's guest checkout, where a card is typed and no account is
     created — which is why it sits above the PayPal button, not inside it. */

  function mountButton(paypal, spec, method) {
    var funding = method === 'card' ? paypal.FUNDING.CARD : paypal.FUNDING.PAYPAL;
    if (!funding) return Promise.resolve(false);

    // Ask only what the SDK can actually answer. getFundingSources is not
    // present on every build, and treating a missing API as "not eligible"
    // silently suppressed BOTH buttons — the guest reached the payment step
    // and found nothing there to pay with. A check that is unavailable means
    // "do not know", never "no"; Buttons.isEligible() below is the authority.
    if (paypal.getFundingSources && paypal.getFundingSources().indexOf(funding) === -1) {
      return Promise.resolve(false);
    }
    if (paypal.isFundingEligible && !paypal.isFundingEligible(funding)) {
      return Promise.resolve(false);
    }

    var host = slot(spec, method);
    var payment = null;
    var stopped = false;   // our own server, or this page, refused to start it; already told

    var buttons = paypal.Buttons({
      fundingSource: funding,
      style: { layout: 'vertical', height: 48, shape: 'rect', label: 'pay' },

      createOrder: function () {
        return createPayment(spec, method).then(function (created) {
          payment = created;
          return created.providerOrderId;
        }).catch(function (err) {
          stopped = true;
          refused(spec, err);
          throw err;
        });
      },

      onApprove: function () {
        if (!payment) return;
        return settle(payment, spec);
      },

      onCancel: function () { cancelled(payment, spec); },
      /* The SDK reports an error. If a payment exists, its state is the
         server's to say: the error may have come after the guest approved it
         (DP-24-01). With none, nothing was started and nothing taken. */
      onError: function () {
        if (payment) { ask(payment, spec, 'provider_error'); return; }
        if (!stopped) spec.onState('failed', { code: 'provider_error' });
      }
    });

    if (!buttons.isEligible || !buttons.isEligible()) { host.remove(); return Promise.resolve(false); }
    return buttons.render(host).then(function () { return true; }, function () {
      host.remove();
      return false;
    });
  }

  /* --- putting the choice on screen ---------------------------------------
     Wallets first, then card, then PayPal: what a phone pays with in two taps
     should not sit below what needs a card number typed. */

  function mount(spec) {
    var onState = spec.onState || function () {};
    var inner = {
      host: spec.host,
      order: spec.order,
      // What is kept on this device beside the payment; never sent anywhere.
      snapshot: spec.snapshot || null,
      amount: spec.amount,
      labels: spec.labels || {},
      onState: onState
    };

    return available().then(function (cfg) {
      if (!cfg.online || !cfg.methods.length) { onState('unavailable'); return; }
      return loadSdk().then(function (paypal) {
        var wanted = cfg.methods;

        // Sequential, not parallel: the order they finish in is the order they
        // appear in, and a payment screen that reshuffles itself as each SDK
        // resolves is a payment screen people abandon.
        var chain = Promise.resolve([]);
        wanted.forEach(function (method) {
          chain = chain.then(function (drawn) {
            return draw(paypal, inner, method).then(function (ok) {
              return drawn.concat(ok);
            });
          });
        });

        return chain.then(function (drawn) {
          if (!drawn.some(Boolean)) { onState('unavailable'); return; }
          onState('ready', { methods: wanted });
        });
      });
    }).catch(function () {
      onState('unavailable');
    });
  }

  function draw(paypal, spec, method) {
    if (method === 'applepay') return mountApplePay(paypal, spec);
    if (method === 'googlepay') return mountGooglePay(paypal, spec);
    return mountButton(paypal, spec, method);
  }

  window.KairoPay = {
    available: available,
    mount: mount,
    statusOf: statusOf,
    remembered: remembered,
    forget: forget,
    cancel: cancel,
    moneyOf: moneyOf,
    holdNew: holdNew,
    wholeOrder: wholeOrder,
    markHandedOver: markHandedOver
  };
})();
