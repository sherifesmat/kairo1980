# Temporary pickup mode — 12 October 2026

Sherif's decision: working alone, pickup only, Tuesday–Sunday 11:00–21:00, Monday closed,
with company lunch collection prominent. No fixed two-hour advance-order requirement while
pickup mode is active. This is temporary, and all previous delivery configuration is retained.

Use **/admin → Service mode** to select Pickup only or restore Delivery and pickup.
No deployment is needed after a switch. Reload the customer page after changing mode.

Each mode stores its own opening week. Editing or resetting pickup hours does not overwrite
the previous `hours` row used for delivery. Zones, fees, minimums, discounts, the original
delivery advance-order rule and DE/EN/AR delivery copy are kept intact. Returning to delivery
restores them. Original delivery copy stays in `data-de/en/ar`; pickup copy uses separate
`data-pickup-de/en/ar` attributes, including server-rendered crawler text and metadata.

The switch changes new order availability; it does not rewrite prior orders or payments,
reopen a closed kitchen, or change Lieferando/Uber Eats/Google settings. Sherif will change
Lieferando and Uber Eats himself. Resolve any outstanding accepted delivery orders individually.

The connected KBOSS website sync can observe `/api/status.serviceMode` and the published week
after its companion KBOSS change is installed. It pauses current delivery advice/measurement
in pickup mode without deleting zones or historical money, and uses the existing dated-hours
writer so earlier dates retain their earlier service hours. KBOSS follows at its next successful
website sync, not immediately when the admin button is pressed.

Verification: 249 Node tests, including real-SQLite mode restoration, original-hours/zone
preservation, authenticated admin switching, closure preservation and rejection of new delivery
quotes/payments/order announcements. Six additional functional DOM probes executed the actual
page/scripts in pickup and delivery modes in DE/EN/AR. A browser install was unavailable locally;
these DOM probes are not a claimed real-Chrome visual test. No live orders were placed.

The former delivery fixtures explicitly select saved delivery mode, keeping their existing
pricing/payment regressions meaningful; new mode tests exercise default pickup and both directions.
