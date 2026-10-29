# Field Visits v3 — web app (Google Apps Script)

These two files are the whole app. The Android APK just opens your `/exec` link, so **you do not need to rebuild the APK** after updating them.

| File | Paste it into |
|---|---|
| `Code.gs` | the `Code.gs` file in Apps Script |
| `Index.html` | the HTML file named `Index` in Apps Script |

## Update your live app (5 minutes, same link)

1. Open your Google Sheet → **Extensions → Apps Script**.
2. Open `Code.gs`, select all, delete, paste the new `Code.gs`. Save.
3. Open `Index`, select all, delete, paste the new `Index.html`. Save.
4. If there is any other `.gs` file (for example `Data.gs` from v2), delete it.
5. **Deploy → Manage deployments → pencil (Edit) → Version: New version → Deploy.**
   Use *Manage deployments*, not *New deployment*, so the link stays the same.
6. Open the app once as manager. The sheet upgrades itself: new columns (`area`, `person_name`, `person_mobile`) and new tabs (`MonthlyTargets`, `Sales`) are added. Nothing is deleted.

## Pages

**Manager**
- **Summary** — top cards: sales and collection vs target, visits, fake visits. Rep table: sales, collection, visits and fake visits of the chosen day (default yesterday), customers. Chart: sales and collection amounts by rep. Every number opens its details.
- **Customers** — add / edit / delete; name, Google Maps link, assigned rep, area. The location is read from the map link automatically.
- **Visits** — month-to-date totals, average daily visits, coverage, fake %, daily trend, rep trend vs team average, visits by rep / hour / area, full visit list.
- **Settings** — users & access (add, disable, reset password to `000000`), monthly targets, sales & collection entries (form or paste from Excel), system options.

**Representative** — own summary, new visit, own visits by day, own customers, change password. Reps never see fake-visit flags.

## Import visits from FocusQuad
**Settings → Import visits** → choose the FocusQuad export (`Month.xlsx` / `Daily.xlsx`) →
pick *Last day / Last 2 days / Last 7 days / Whole file* → **Import** → **Open these visits**.
Visits already in the app are skipped, so importing the same file again is safe.

## Sales & collection data
Easiest: **Settings → Sales & collection → Download blank form**, fill one line per invoice or
collection (rep and type are dropdowns), then **Upload filled form** → check the preview → **Import**.
Rows already imported are skipped. You can also add single entries there, paste rows from Excel
(`Date | Rep email or name | Sales/Collection | Amount | Customer | Ref`),
or type straight into the `Sales` tab of the sheet.
Targets carry forward to the next month until you change them.
