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

  function remembered() {
    try {
      var raw = localStorage.getItem(STORE_KEY);
      if (!raw) return null;
      var record = JSON.parse(raw);
      if (!record || !record.id || Date.now() - (record.at || 0) > 3600000) { forget(); return null; }
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

  function forget() {
    try { localStorage.removeItem(STORE_KEY); } catch (e) { /* nothing to do */ }
  }

  function statusOf(id) {
    return api('/api/payments/' + encodeURIComponent(id)).then(function (data) {
      return data.payment;
    });
  }

  /* --- the three steps every method shares --------------------------------
     Create the payment on our server (which prices it), let the guest approve
     it however their method approves things, then ask our server what became
     of it. Only the middle step differs between a wallet and a button. */

  function createPayment(spec, method) {
    spec.onState('paying');
    var body = {};
    Object.keys(spec.order).forEach(function (k) { body[k] = spec.order[k]; });
    body.method = method;

    return api('/api/payments', { method: 'POST', body: body }).then(function (payment) {
      /* The order the payment is for, kept beside it on this device so a reload
         hands over THAT order, not whatever the page shows by then. No name, no
         phone, no address: only what the server matches the payment by. */
      var o = spec.order || {};
      var shown = spec.snapshot || {};
      remember({ id: payment.id, reference: payment.reference, amount: payment.amount, at: Date.now(),
                 order: { items: o.items, type: o.type, business: !!o.business,
                          postcode: o.postcode, town: o.town || null,
                          time: o.time || null, when: o.when || null,
                          lines: shown.lines, subtotal: shown.subtotal, discount: shown.discount,
                          fee: shown.fee, total: shown.total } });
      return payment;
    });
  }

  function settle(payment, spec, errorCode) {
    return api('/api/payments/' + encodeURIComponent(payment.id) + '/capture', { method: 'POST' })
      .then(function (data) { report(data.payment, spec, errorCode); })
      .catch(function (err) {
        if (err.data && err.data.payment) { report(err.data.payment, spec, err.data.error); return; }
        spec.onState('failed', { code: err.code });
      });
  }

  function report(payment, spec, errorCode) {
    if (!payment) { spec.onState('failed', {}); return; }
    // Kept, not forgotten: the page forgets it once the server has the order
    // (or has flagged it for a person). Until then a reload can still hand it
    // over (DP-23-02).
    if (payment.status === 'captured') { spec.onState('paid', { payment: payment }); return; }
    if (payment.status === 'pending') { spec.onState('pending', { payment: payment }); return; }
    if (payment.status === 'cancelled') { forget(); spec.onState('cancelled', { payment: payment }); return; }
    forget();
    spec.onState('failed', { payment: payment, code: errorCode || payment.failureCode });
  }

  function cancelled(payment, spec) {
    if (payment) {
      api('/api/payments/' + encodeURIComponent(payment.id) + '/cancel', { method: 'POST' })
        .catch(function () { /* the webhook and reconciliation still cover it */ });
    }
    forget();
    spec.onState('cancelled');
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
            if (payment) settle(payment, spec, 'declined');
            else spec.onState('failed', { code: err && err.code });
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
      if (payment) settle(payment, spec, 'declined');
      else spec.onState('failed', { code: err && err.code });
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

    var buttons = paypal.Buttons({
      fundingSource: funding,
      style: { layout: 'vertical', height: 48, shape: 'rect', label: 'pay' },

      createOrder: function () {
        return createPayment(spec, method).then(function (created) {
          payment = created;
          return created.providerOrderId;
        }).catch(function (err) {
          spec.onState('failed', { code: err.code });
          throw err;
        });
      },

      onApprove: function () {
        if (!payment) return;
        return settle(payment, spec);
      },

      onCancel: function () { cancelled(payment, spec); },
      onError: function () { spec.onState('failed', { code: 'provider_error' }); }
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
    markHandedOver: markHandedOver
  };
})();
