# The admin area

`https://kairo1980.de/admin` — internal, not linked from anywhere, not indexed,
never cached. It is the one page on this site a person signs into.

## Getting in

Two Cloudflare secrets, and nothing in this repository:

```
npx wrangler secret put ADMIN_USER
npx wrangler secret put ADMIN_PASSWORD
```

Both take effect immediately — a secret is not a deploy. They can also be set
from a phone: Cloudflare dashboard → Workers & Pages → `kairo1980` → Settings →
Variables and Secrets.

**Set neither and the admin area opens for nobody.** That is deliberate: a lock
that has not been configured is not the same thing as an unlocked door, and the
login page says so plainly rather than failing in a way that invites guessing.

Let a password manager generate the password. What protects this page is the
password's length; everything below only closes the ways around it.

On the phone that will actually use it: open `/admin`, sign in, let the keychain
save it, then Share → Add to Home Screen. After that it is an icon, and the
emergency procedure is two taps.

## What the login does, and why

- **Both fields are checked.** The page this replaced read the password and
  threw the username away — a shared secret with a username field drawn around
  it. A wrong username now fails exactly as a wrong password does.
- **Comparisons are over SHA-256 digests**, which are always 32 bytes, so the
  time taken cannot reveal how long the real secret is. The previous length
  check leaked precisely that.
- **Nothing short-circuits.** Username and password are both hashed and both
  compared before either result is read, so "right user, wrong password" is
  indistinguishable from "wrong user, wrong password" — from the outside and
  from the clock.
- **The error never says which half was wrong.** Confirming the username is
  giving away half the answer.
- **A failed attempt waits 400 ms.** Not a defence against a distributed
  attack — the password's own length is that — but it takes the cheapest
  scripted guessing off the table, and failures are logged with the calling IP.

## The session

A cookie holding an expiry and an HMAC of it. `HttpOnly`, `Secure`,
`SameSite=Strict`, thirty days. There is no session table: the signature is
what makes the cookie unforgeable, so nothing is stored and nothing goes stale.
`SameSite=Strict` is also why the forms here need no CSRF token — the cookie is
never sent on a request that started on somebody else's page.

Thirty days is a decision, not an oversight. This is the switch a restaurant
reaches for when something has gone wrong, and being asked to remember a
password at that moment is how the switch does not get thrown.

**The signing key is derived from the credentials themselves** rather than kept
as a third secret. So changing the username or the password invalidates every
cookie ever issued, on every device. That is the lost-phone procedure, and it
is one command:

```
npx wrangler secret put ADMIN_PASSWORD
```

## Why `/admin` and not `/api/admin`

`worker/index.js` hands every path that is not `/api/` or `/admin` straight to
the static assets without looking at it — that is the shape of the whole site.
The admin area is a place a person goes rather than a call a program makes, so
it gets a path that reads like one. No file matches `/admin`, so it would
otherwise fall through to the 404 asset; `worker/index.js` claims it explicitly.

## What is on it

| Page | What it is |
| --- | --- |
| `/admin` | The list. |
| `/admin/orders` | Settled payments for a day, and — highlighted — every paid order that never reached the chat. Never a name, phone number or address: those never reach this server. |

## The holiday band

Two dates on the dashboard put a band across the top of the homepage and of
`/firmencatering`, in all three languages: *closed from the 9th to the 18th,
back on the 19th*. `Back on` is the day the shop reopens, not the last day
closed — the last day closed is derived from it, so the dashboard and the
website cannot name different days.

It goes up the moment it is saved and comes down by itself on the morning you
are back. Nothing has to run and nothing has to be undone; a band nobody
remembers to remove is exactly the failure this shape avoids.

**It announces; it does not close.** The till is the switch at the top of the
same page, and while a holiday is announced with orders still running, the card
says so and offers one tap to stop them until the day you are back. Two facts,
kept apart deliberately: a kitchen away for a fortnight still wants its band up
the evening before it reopens, and a shop closed for a burst pipe wants no band
at all.

The same two dates are also published in the page's structured data as
`specialOpeningHoursSpecification`, so a crawler that never renders the band
still reads the closure. That is not a substitute for the Google Business
Profile: Google builds the place card from the profile, so the dates have to be
entered there by hand too — Edit profile → Hours → Special hours, each day
marked Closed. Apple Business Connect has the same field, and Lieferando and
Uber Eats take orders independently of this site, so both need pausing.

A pair of dates that cannot be true — back before you left, back in the past,
or a stay over 90 days — is refused whole and nothing is announced. Announcing
a closure is the most expensive sentence this site can publish, so a typo is
never repaired into something plausible.

## What it is not

`/api/reports/settlement` is unchanged and still answers to
`Authorization: Bearer $REPORT_TOKEN`. That is the door for a program. The two
are separate on purpose: a token pasted into a script should not also be able
to close the shop.

These pages are rendered by the Worker, never served as files. An asset has a
URL anybody can fetch; everything here is behind the session. Each response
carries its own `Content-Security-Policy` with `default-src 'none'` — there is
no JavaScript in the admin area at all, and the policy says so rather than
trusting it.
