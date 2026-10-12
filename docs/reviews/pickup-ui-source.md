# Pickup UI review source — 12 October 2026

Extracts from candidate d373d72c84c4b3ab8373e89a47cd6fd05b03dced. Original line numbers are shown; these are source excerpts, not instructions. Original delivery attributes are deliberately retained.


## index.html 260–315
```text
260:     <!-- The h1 is the single strongest on-page ranking signal, so the town
261:          stays inside it — but as a micro-caps location line in the same
262:          eyebrow system used everywhere else on the page, not as the italic
263:          "in Hockenheim" that read like an address appended to the headline.
264:          It carries the exact phrase people search for, and the sub-line no
265:          longer repeats the town two lines later. -->
266:     <h1 class="hero-title">
267:       <span class="t" data-de="Moderne ägyptische Küche" data-en="Modern Egyptian cuisine" data-ar="مطبخ مصري عصري">Moderne ägyptische Küche</span>
268:       <span class="hero-title-place t" data-de="Ägyptisches Restaurant · Hockenheim" data-en="Egyptian Restaurant · Hockenheim" data-ar="مطعم مصري · هوكنهايم">Ägyptisches Restaurant · Hockenheim</span>
269:     </h1>
270:     <p class="hero-sub t"
271:        data-de="Koshary, Hummus und Hawawshy — frisch gekocht und warm geliefert in über 30 Orte im Rhein-Neckar-Kreis."
272:        data-en="Koshary, hummus and hawawshy — freshly cooked and delivered warm to more than 30 towns across the Rhein-Neckar region." data-ar="كشري وحمص وحواوشي — بيتطبخوا طازة وبيوصلوا سخنين لأكتر من 30 مدينة في منطقة راين-نيكار." data-pickup-de="Frisch gekochte ägyptische Küche zum Abholen in Hockenheim. Bestellen Sie für sich oder das Mittagessen Ihres Teams und holen Sie Ihre Bestellung in der Rostocker Straße 20a ab. Keine Lieferung." data-pickup-en="Fresh Egyptian food for pickup in Hockenheim. Order for yourself or your team lunch and collect at Rostocker Straße 20a. No delivery." data-pickup-ar="أكل مصري طازة للاستلام من المطعم في هوكنهايم. اطلب لنفسك أو لغدا فريقك واستلم من Rostocker Straße 20a. مفيش توصيل.">Koshary, Hummus und Hawawshy — frisch gekocht und warm geliefert in über 30 Orte im Rhein-Neckar-Kreis.</p>
273:     <!-- One order route, not two. The WhatsApp button that stood here opened a
274:          second, worse way of ordering the same food — the basket composes the
275:          same message with quantities, address and total already in it. -->
276:     <div class="hero-actions">
277:       <a href="#speisekarte" class="btn-primary t" data-de="Speisekarte ansehen" data-en="View the menu" data-ar="شوف المنيو" data-pickup-de="Bestellen &amp; abholen" data-pickup-en="Order for pickup" data-pickup-ar="اطلب واستلم">Speisekarte ansehen</a>
278:       <a href="#liefergebiet" class="btn-ghost t" data-de="Liefern wir zu Ihnen?" data-en="Do we deliver to you?" data-ar="بنوصّل لعندك؟" data-pickup-de="Abholung in Hockenheim" data-pickup-en="Pickup in Hockenheim" data-pickup-ar="الاستلام في هوكنهايم" data-pickup-href="#kontakt">Liefern wir zu Ihnen?</a>
279:     </div>
280:     <p class="hero-offer">
281:       <span class="hero-offer-mark"><span data-cfg="discount">10</span> %</span>
282:       <span class="hero-offer-text t" data-de="Rabatt auf Direktbestellungen" data-en="off on direct orders" data-ar="خصم على الطلب المباشر من موقعنا">Rabatt auf Direktbestellungen</span>
283:     </p>
284:   </div>
285: </section>
286: 
287: 
288: <section class="pickup-guide" aria-labelledby="pickupGuideTitle">
289:   <div class="pickup-guide-heading">
290:     <span class="pickup-guide-tag t" data-de="Nur Abholung" data-en="Pickup only" data-ar="استلام من المطعم فقط">Nur Abholung</span>
291:     <h2 id="pickupGuideTitle" class="t" data-de="Frisch gekocht. Bei uns abholen." data-en="Freshly cooked. Ready to collect." data-ar="أكل طازة. تستلمه من عندنا.">Frisch gekocht. Bei uns abholen.</h2>
292:   </div>
293:   <div class="pickup-guide-details">
294:     <div><span class="pickup-guide-label t" data-de="Reguläre Abholzeiten" data-en="Regular pickup hours" data-ar="مواعيد الاستلام المعتادة">Reguläre Abholzeiten</span>
295:       <p id="pickupWeek" class="t" data-de="Zeiten unten ansehen" data-en="See hours below" data-ar="شوف المواعيد تحت">Zeiten unten ansehen</p></div>
296:     <div><span class="pickup-guide-label t" data-de="Hier abholen" data-en="Collect here" data-ar="الاستلام من هنا">Hier abholen</span>
297:       <a href="#kontakt">Rostocker Straße 20a · Hockenheim</a></div>
298:     <div><span class="pickup-guide-label t" data-de="Für Ihr Team" data-en="For your team" data-ar="لفريقك">Für Ihr Team</span>
299:       <a class="t" href="/firmencatering" data-de="Mittagessen fürs Büro →" data-en="Office lunch →" data-ar="غدا المكتب ←">Mittagessen fürs Büro →</a></div>
300:   </div>
301:   <p class="order-off pickup-guide-status" hidden></p>
302: </section>
303: 
304: <div class="strip fade-in">
305:   <div class="strip-item">
306:     <span class="strip-num">01</span>
307:     <div class="strip-title t" data-de="Frisch zubereitet" data-en="Freshly prepared" data-ar="بيتحضّر طازة">Frisch zubereitet</div>
308:     <p class="strip-text t" data-de="Jedes Gericht wird erst nach Bestellung zubereitet." data-en="Every dish is prepared fresh after you order." data-ar="كل طبق بيتحضّر بعد ما تطلبه، مش قبل كده.">Jedes Gericht wird erst nach Bestellung zubereitet.</p>
309:   </div>
310:   <div class="strip-item">
311:     <span class="strip-num">02</span>
312:     <div class="strip-title t" data-de="Handgemacht" data-en="Handmade" data-ar="شغل إيد">Handgemacht</div>
313:     <p class="strip-text t" data-de="Keine Fertigprodukte. Saucen frisch, Gemüse von Hand." data-en="No ready-made products. Sauces freshly made, vegetables cut by hand." data-ar="مفيش حاجة جاهزة. الصوصات بتتعمل عندنا، والخضار بيتقطّع بالإيد.">Keine Fertigprodukte. Saucen frisch, Gemüse von Hand.</p>
314:   </div>
315:   <div class="strip-item">
```


## index.html 385–398
```text
385:         <p class="t" data-de="Jedes Gericht erzählt ein Stück Geschichte. Inspiriert von Familienküchen, den Straßen Kairos und den Geschmäckern, mit denen viele Ägypter aufgewachsen sind." data-en="Every dish tells a piece of history. Inspired by family kitchens, the streets of Cairo and the flavours many Egyptians grew up with." data-ar="كل طبق بيحكي جزء من حكاية. مستوحى من مطابخ البيوت، ومن شوارع القاهرة، ومن الطعم اللي كبر عليه ناس كتير في مصر.">Jedes Gericht erzählt ein Stück Geschichte. Inspiriert von Familienküchen, den Straßen Kairos und den Geschmäckern, mit denen viele Ägypter aufgewachsen sind.</p>
386:         <p class="t" data-de="Wir sind kein Fast Food, das nur authentisch wirken möchte. Und keine künstliche Luxusmarke, die sich zu wichtig nimmt." data-en="We are not fast food trying to look authentic. And not an artificial luxury brand that takes itself too seriously." data-ar="إحنا مش وجبات سريعة بتحاول تبان أصيلة، ولا ماركة فخامة مصطنعة بتاخد نفسها أكبر من حجمها.">Wir sind kein Fast Food, das nur authentisch wirken möchte. Und keine künstliche Luxusmarke, die sich zu wichtig nimmt.</p>
387:         <p class="t" data-de="KAIRO 1980 steht für warmes, ehrliches Essen — gemacht für echte Momente: für entspannte Abende zuhause, gemeinsames Essen mit Freunden, nächtliche Cravings und die kleinen Augenblicke, die man wirklich genießt." data-en="KAIRO 1980 stands for warm, honest food — made for real moments: relaxed evenings at home, sharing food with friends, late-night cravings and the small moments you truly enjoy." data-ar="KAIRO 1980 معناه أكل دافي وصادق — متعمول للحظات حقيقية: سهرة هادية في البيت، أكل مع الأصحاب، جوع نص الليل، واللحظات الصغيرة اللي بتستمتع بيها فعلاً.">KAIRO 1980 steht für warmes, ehrliches Essen — gemacht für echte Momente: für entspannte Abende zuhause, gemeinsames Essen mit Freunden, nächtliche Cravings und die kleinen Augenblicke, die man wirklich genießt.</p>
388:         <p class="t" data-de="Von rauchigem Baba Ganoush über goldene, knusprige Pommes bis hin zu aromatischen Reisgerichten, frischem ägyptischem Brot und langsam gekochten Rezepten voller Gewürze und Nostalgie — jede Bestellung soll vertraut, großzügig und unvergesslich wirken." data-en="From smoky Baba Ganoush to golden crispy fries, aromatic rice dishes, fresh Egyptian bread and slow-cooked recipes full of spices and nostalgia — every order should feel familiar, generous and unforgettable." data-ar="من بابا غنوج مدخّن، لبطاطس دهبي مقرمشة، لأطباق رز مليانة ريحة، وعيش مصري طازة، ووصفات بتتطبخ على نار هادية مليانة بهارات وذكريات — كل طلب المفروض يحسّسك إنك في بيتك، وإنه كريم، وإنه مش هيتنسي.">Von rauchigem Baba Ganoush über goldene, knusprige Pommes bis hin zu aromatischen Reisgerichten, frischem ägyptischem Brot und langsam gekochten Rezepten voller Gewürze und Nostalgie — jede Bestellung soll vertraut, großzügig und unvergesslich wirken.</p>
389:         <p class="t" data-de="Denn für uns ist Essen etwas Emotionales. Es verbindet Menschen mit Erinnerungen. Mit Kultur. Mit Heimat." data-en="Because for us, food is something emotional. It connects people with memories. With culture. With home." data-ar="لأن الأكل عندنا إحساس. بيوصّل الناس بذكرياتهم. وبثقافتهم. وببلدهم.">Denn für uns ist Essen etwas Emotionales. Es verbindet Menschen mit Erinnerungen. Mit Kultur. Mit Heimat.</p>
390:         <p><strong class="t" data-de="KAIRO 1980 ist modernes Kairo-Gefühl — direkt zu dir nach Hause." data-en="KAIRO 1980 is the modern Cairo feeling — delivered straight to your door." data-ar="KAIRO 1980 هو إحساس القاهرة العصرية — لحد باب بيتك." data-pickup-de="KAIRO 1980 ist modernes Kairo-Gefühl — frisch gekocht und bereit zum Mitnehmen." data-pickup-en="KAIRO 1980 is the modern Cairo feeling — freshly cooked and ready to take home." data-pickup-ar="KAIRO 1980 هو إحساس القاهرة العصرية — أكل طازة جاهز تاخده معاك.">KAIRO 1980 ist modernes Kairo-Gefühl — direkt zu dir nach Hause.</strong></p>
391:       </div>
392:       <button class="mehr-lesen-btn" id="mehrLesenBtn" data-action="toggle-story" aria-expanded="false" aria-controls="mehrLesenContent"><span class="t" data-de="Mehr lesen" data-en="Read more" data-ar="اقرأ المزيد">Mehr lesen</span></button>
393:     </div>
394:   </div>
395: </section>
396: 
397: <section id="speisekarte" class="fade-in">
398:   <div class="menu-section">
```


## firmencatering.html 158–175
```text
158:     <span class="menu-eyebrow t" data-de="Für Unternehmen" data-en="For companies" data-ar="للشركات">Für Unternehmen</span>
159:     <!-- The heading and the lead are also the Service node's name and
160:          description: order.js reads them back off the page in whatever
161:          language it is being read, so the markup can never describe a service
162:          the page does not offer. -->
163:     <h1 class="business-title t" id="serviceName"
164:         data-de="Firmencatering &amp; Büro-Catering im Rhein-Neckar-Kreis"
165:         data-en="Corporate &amp; office catering across the Rhein-Neckar district"
166:         data-ar="تجهيز أكل الشركات والمكاتب في منطقة راين-نيكار" data-pickup-de="Mittagessen fürs Team — zum Abholen in Hockenheim" data-pickup-en="Team lunch — for pickup in Hockenheim" data-pickup-ar="غدا الفريق — للاستلام في هوكنهايم">Firmencatering &amp; Büro-Catering im Rhein-Neckar-Kreis</h1>
167:     <p class="business-lead t" id="serviceDescription"
168:        data-de="Ägyptische Küche für Meetings, Team-Lunches und Firmenfeiern in Hockenheim, Walldorf, Wiesloch, Schwetzingen und St. Leon-Rot — frisch gekocht, warm geliefert oder abholbereit verpackt. Kennzeichnungspflichtige Allergene stehen bei jedem Gericht, vegane und vegetarische Gerichte sind ausgewiesen."
169:        data-en="Egyptian food for meetings, team lunches and company celebrations in Hockenheim, Walldorf, Wiesloch, Schwetzingen and St. Leon-Rot — freshly cooked, delivered warm or packed ready for collection. The allergens requiring declaration are listed with every dish, and vegan and vegetarian dishes are marked."
170:        data-ar="أكل مصري للاجتماعات وغداء الفريق وحفلات الشركة في Hockenheim و Walldorf و Wiesloch و Schwetzingen و St. Leon-Rot — بيتطبخ طازة، وبيوصل سخن أو بيتجهّز للاستلام. ومسببات الحساسية الواجب الإعلان عنها مكتوبة مع كل طبق، والأطباق النباتية والفيجن متعلّمة." data-pickup-de="Frisch gekochte ägyptische Küche zum Abholen in Hockenheim. Bestellen Sie für sich oder das Mittagessen Ihres Teams und holen Sie Ihre Bestellung in der Rostocker Straße 20a ab. Keine Lieferung." data-pickup-en="Fresh Egyptian food for pickup in Hockenheim. Order for yourself or your team lunch and collect at Rostocker Straße 20a. No delivery." data-pickup-ar="أكل مصري طازة للاستلام من المطعم في هوكنهايم. اطلب لنفسك أو لغدا فريقك واستلم من Rostocker Straße 20a. مفيش توصيل.">Ägyptische Küche für Meetings, Team-Lunches und Firmenfeiern in Hockenheim, Walldorf, Wiesloch, Schwetzingen und St. Leon-Rot — frisch gekocht, warm geliefert oder abholbereit verpackt. Kennzeichnungspflichtige Allergene stehen bei jedem Gericht, vegane und vegetarische Gerichte sind ausgewiesen.</p>
171: 
172:     <!-- The delivery shift in one sentence, written by order.js from
173:          config.js -> hours.deliveryFrom. Empty and hidden when there is nothing
174:          to announce, so this page can never promise a midday delivery the
175:          ordering page refuses. -->
```


## firmencatering.html 191–233
```text
191:     <!-- The first three cards are the formats, and are the only thing the
192:          OfferCatalog in the head is built from: .service-format is the hook,
193:          so a format removed from the page leaves the markup at the same time.
194:          The three after them are what this kitchen can state and most cannot —
195:          a declaration on every dish, diet tags, and an invoice. -->
196:     <div class="business-grid is-three-up">
197:       <div class="bcard service-format">
198:         <span class="bcard-num">01</span>
199:         <h2 class="bcard-title service-format-name t" data-de="Meeting-Catering" data-en="Meeting catering" data-ar="تجهيز الاجتماعات">Meeting-Catering</h2>
200:         <p class="bcard-text service-format-text t"
201:            data-de="Warme Gerichte und Mezze für Besprechungen, Workshops und Schulungen — zur vereinbarten Uhrzeit geliefert oder abholbereit verpackt. Jedes Gericht kommt in seiner eigenen Schale, sodass sich am Tisch jeder nimmt, was er möchte."
202:            data-en="Warm dishes and mezze for meetings, workshops and training days — delivered at the agreed time or packed ready for collection. Every dish comes in its own container, so everyone at the table helps themselves to what they want."
203:            data-ar="أطباق سخنة ومزّة للاجتماعات والورش والتدريبات — بتتوصّل في الميعاد المتفق عليه أو بتتجهّز للاستلام. وكل طبق بييجي في وعاء لوحده، فكل واحد على السفرة ياخد اللي يحبه." data-pickup-de="Warme Gerichte und Mezze für Ihr Meeting. Wählen Sie Gerichte und Mengen und holen Sie die Bestellung zur bestätigten Zeit ab." data-pickup-en="Warm dishes and mezze for your meeting. Choose dishes and quantities, then collect at the confirmed time." data-pickup-ar="أطباق سخنة ومزّة لاجتماعكم. اختار الأطباق والكميات واستلم الطلب في الميعاد اللي بنأكده.">Warme Gerichte und Mezze für Besprechungen, Workshops und Schulungen — zur vereinbarten Uhrzeit geliefert oder abholbereit verpackt. Jedes Gericht kommt in seiner eigenen Schale, sodass sich am Tisch jeder nimmt, was er möchte.</p>
204:       </div>
205:       <div class="bcard service-format">
206:         <span class="bcard-num">02</span>
207:         <h2 class="bcard-title service-format-name t" data-de="Team-Lunch im Büro" data-en="Team lunch at the office" data-ar="غداء الفريق في المكتب">Team-Lunch im Büro</h2>
208:         <p class="bcard-text service-format-text t"
209:            data-de="Mittagessen für Ihr Team, so oft Sie möchten — einmalig oder als feste wöchentliche Bestellung, die wir Ihnen als Vorlage anlegen. {deliveryClause}"
210:            data-en="Lunch for your team, as often as you like — one-off or as a standing weekly order that we keep on file as a template for you. {deliveryClause}"
211:            data-ar="غداء لفريقك بالمرات اللي تحبها — مرة واحدة أو طلب أسبوعي ثابت بنحفظه ليك كقالب. {deliveryClause}" data-pickup-de="Ein Mittagessen für alle: Stellen Sie den Warenkorb fürs Team zusammen und geben Sie Ihre gewünschte Abholzeit an. Wir bestätigen, was sich zeitlich zubereiten lässt." data-pickup-en="One lunch order for the team: build your basket and request a pickup time. We confirm what we can prepare for that time." data-pickup-ar="طلب غدا واحد للفريق: جمّع الأطباق في السلة واختار ميعاد الاستلام. بنأكد اللي نقدر نجهزه في الوقت المطلوب.">Mittagessen für Ihr Team, so oft Sie möchten — einmalig oder als feste wöchentliche Bestellung, die wir Ihnen als Vorlage anlegen.</p>
212:       </div>
213:       <div class="bcard service-format">
214:         <span class="bcard-num">03</span>
215:         <h2 class="bcard-title service-format-name t" data-de="Firmenfeier &amp; Empfang" data-en="Company celebration &amp; reception" data-ar="حفلات الشركة والاستقبالات">Firmenfeier &amp; Empfang</h2>
216:         <p class="bcard-text service-format-text t"
217:            data-de="Größere Runden — Jubiläen, Einweihungen, Sommerfeste. Sagen Sie uns Bestellwert und Uhrzeit; Menge, Zeit und Preis bestätigen wir vorab schriftlich."
218:            data-en="Larger gatherings — anniversaries, openings, summer parties. Tell us the order value and the time; we confirm quantities, time and price in writing beforehand."
219:            data-ar="لمّات أكبر — أعياد تأسيس، افتتاحات، حفلات صيفية. قول لنا قيمة الطلب والساعة، وإحنا بنأكد الكمية والوقت والسعر كتابةً قبلها." data-pickup-de="Für größere Gruppen stimmen wir Gerichte, Mengen und Abholzeit vorher mit Ihnen ab. Schreiben Sie uns die Details per WhatsApp." data-pickup-en="For larger groups, we agree dishes, quantities and pickup time with you in advance. Send us the details on WhatsApp." data-pickup-ar="للمجموعات الكبيرة بنتفق معاك على الأطباق والكميات وميعاد الاستلام. ابعتلنا التفاصيل على واتساب.">Größere Runden — Jubiläen, Einweihungen, Sommerfeste. Sagen Sie uns Bestellwert und Uhrzeit; Menge, Zeit und Preis bestätigen wir vorab schriftlich.</p>
220:       </div>
221:       <div class="bcard">
222:         <span class="bcard-num">04</span>
223:         <h2 class="bcard-title t" data-de="Lieferung frei ab {freeDeliveryFrom} €" data-en="Free delivery from €{freeDeliveryFrom}" data-ar="توصيل مجاني من {freeDeliveryFrom} €" data-pickup-de="Mittagessen zum Abholen" data-pickup-en="Lunch for pickup" data-pickup-ar="غدا للاستلام">Lieferung frei ab 100 €</h2>
224:         <p class="bcard-text t"
225:            data-de="Ab {freeDeliveryFrom} € Bestellwert übernehmen wir die Liefergebühr — im gesamten Liefergebiet rund um Hockenheim, für jede Bestellung, privat wie geschäftlich. Darunter gilt die Gebühr Ihrer Postleitzahl, wie unten aufgeführt. Ein Mindestbestellwert gilt für Firmenbestellungen nicht. {deliveryClause}"
226:            data-en="From €{freeDeliveryFrom} we cover the delivery fee — anywhere in our delivery area around Hockenheim, on every order, private or corporate. Below that, the fee for your postcode applies, as listed below. No minimum order value applies to company orders. {deliveryClause}"
227:            data-ar="من {freeDeliveryFrom} € وفوق بنتحمّل رسوم التوصيل — في كل منطقة التوصيل حوالين هوكنهايم، وعلى أي طلب، فرد أو شركة. أقل من كده بتتحسب رسوم الرمز البريدي بتاعك زي ما هي تحت. وطلبات الشركات مفيهاش حد أدنى للطلب. {deliveryClause}" data-pickup-de="Frisch gekochte ägyptische Küche zum Abholen in Hockenheim. Bestellen Sie für sich oder das Mittagessen Ihres Teams und holen Sie Ihre Bestellung in der Rostocker Straße 20a ab. Keine Lieferung." data-pickup-en="Fresh Egyptian food for pickup in Hockenheim. Order for yourself or your team lunch and collect at Rostocker Straße 20a. No delivery." data-pickup-ar="أكل مصري طازة للاستلام من المطعم في هوكنهايم. اطلب لنفسك أو لغدا فريقك واستلم من Rostocker Straße 20a. مفيش توصيل.">Ab 100 € Bestellwert übernehmen wir die Liefergebühr — im gesamten Liefergebiet rund um Hockenheim, für jede Bestellung, privat wie geschäftlich. Darunter gilt die Gebühr Ihrer Postleitzahl, wie unten aufgeführt. Ein Mindestbestellwert gilt für Firmenbestellungen nicht.</p>
228:       </div>
229:       <div class="bcard">
230:         <span class="bcard-num">05</span>
231:         <h2 class="bcard-title t" data-de="Auf die Minute geplant" data-en="Planned to the minute" data-ar="مظبوط بالدقيقة">Auf die Minute geplant</h2>
232:         <p class="bcard-text t"
233:            data-de="Sagen Sie uns die Uhrzeit, zu der gegessen wird. Wir kochen so, dass alles warm und pünktlich bei Ihnen steht, und bestätigen Menge, Zeit und Preis vorab schriftlich. Ab {leadTimeHours} Stunden Vorlauf ist das sicher planbar."
```


## firmencatering.html 265–281
```text
265:            data-de="Eine Rechnung stellen wir jedem aus, der eine braucht — auf Wunsch mit Firmenanschrift. Als Kleinunternehmer nach § 19 UStG weisen wir darin keine Umsatzsteuer aus. Regelmäßige Bestellungen legen wir Ihnen als Vorlage an."
266:            data-en="We issue an invoice to anyone who needs one — with your company address if you like. As a small business under § 19 UStG it does not show VAT. We save recurring orders as a template for you."
267:            data-ar="بنطلّع فاتورة لأي حد محتاجها — وبعنوان الشركة لو حبيت. وبما إننا مشروع صغير طبقاً لـ § 19 UStG فمفيش ضريبة قيمة مضافة موضحة فيها. والطلبات المتكررة بنحفظها ليك كقالب.">Eine Rechnung stellen wir jedem aus, der eine braucht — auf Wunsch mit Firmenanschrift. Als Kleinunternehmer nach § 19 UStG weisen wir darin keine Umsatzsteuer aus. Regelmäßige Bestellungen legen wir Ihnen als Vorlage an.</p>
268:       </div>
269:     </div>
270: 
271:     <p class="business-hours" id="businessHours"></p>
272: 
273:     <div class="business-cta">
274:       <a href="https://wa.me/4917679906621" target="_blank" rel="noopener" class="btn-primary t" data-wa-template="business" data-de="Angebot per WhatsApp anfragen" data-en="Request a quote via WhatsApp" data-ar="اطلب عرض سعر على واتساب" data-pickup-de="Team-Bestellung besprechen" data-pickup-en="Discuss a team order" data-pickup-ar="نتفق على طلب الفريق">Angebot per WhatsApp anfragen</a>
275:       <a href="/#speisekarte" class="btn-line t" data-de="Speisekarte ansehen" data-en="View the menu" data-ar="شوف المنيو">Speisekarte ansehen</a>
276:     </div>
277:   </div>
278: </section>
279: 
280: <!-- The same list, from the same spreadsheet, as the ordering page and the
281:      basket. Rendered rather than retyped: a postcode added to the zones is
```


## order.js 4245–4268
```text
4245:   function renderBusinessHours() {
4246:     if (pickupOnly()) {
4247:       // The Worker publishes the complete saved week in translated attributes.
4248:       // Leave it intact rather than treating Tuesday as every day's schedule.
4249:       var h = document.getElementById("businessHours");
4250:       if (h && !h.getAttribute('data-de')) h.textContent = t().pickupLabel;
4251:       return;
4252:     }
4253:     var host = document.getElementById('businessHours');
4254:     if (!host) return;
4255:     var L = t();
4256:     host.textContent = deliveryNotice() ? L.hoursByArrangement : L.businessByArrangement;
4257:   }
4258: 
4259:   // The template asks for what actually decides the order — budget and time —
4260:   // and no longer for a head count, which told us nothing we could cook from.
4261:   function businessTemplate(kind) {
4262:     if (pickupOnly()) return t().waPickup;
4263:     var L = t();
4264:     return kind === 'business' ? L.waBusiness : L.waSimple;
4265:   }
4266: 
4267:   /* =========================================================================
4268:      Boot
```


## style.css 2087–2125
```text
2087: 
2088: /* The temporary pickup guide uses the same warm palette as the restaurant. */
2089: .pickup-guide { display:none; max-width:1160px; margin:0 auto; padding:32px 40px; }
2090: body.pickup-only .pickup-guide { display:block; }
2091: .pickup-guide-heading { display:flex; align-items:center; gap:18px; flex-wrap:wrap; margin-bottom:22px; }
2092: .pickup-guide-tag { padding:8px 12px; border:1px solid #b8914a; color:#785921; font-size:12px; font-weight:500; letter-spacing:.06em; }
2093: .pickup-guide h2 { font-family:'Cormorant Garamond',serif; font-weight:400; font-size:30px; line-height:1.2; }
2094: .pickup-guide-details { display:grid; grid-template-columns:1.3fr 1.3fr 1fr; gap:24px; }
2095: .pickup-guide-label { display:block; color:#785921; font-size:11px; letter-spacing:.07em; margin-bottom:8px; text-transform:uppercase; }
2096: .pickup-guide-details p, .pickup-guide-details a { font-size:14px; line-height:1.65; color:#1c1409; font-weight:400; }
2097: .pickup-guide-details a { text-decoration:underline; text-decoration-color:#b8914a; text-underline-offset:4px; }
2098: .pickup-guide-status { margin-top:20px; padding-top:16px; border-top:1px solid #e5dac6; font-size:14px; line-height:1.6; }
2099: @media(max-width:700px) {
2100:   .pickup-guide { padding:26px 24px; }
2101:   .pickup-guide h2 { font-size:27px; }
2102:   .pickup-guide-details { grid-template-columns:1fr; gap:18px; }
2103: }
```
