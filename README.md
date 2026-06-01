# my-exam-live

Live scraper repo for the current exam year.

Published paths:
- `data/latest.json`
- `data/all_results.json`
- `data/regions/...`
- `data/pdfs/...`
- `data/stats/...` for the live year

This repo keeps the scheduled GitHub Actions workflow.

## Release countdown metadata

Keep the live feed disabled until an official announcement is published:

```json
"release": null
```

When the official release time and source are available, enable the countdown by adding release metadata to `data/latest.json` metadata:

```json
"release": {
  "status": "scheduled",
  "releaseAt": "2026-07-27T04:00:00+06:30",
  "sourceUrl": "https://official-source-url",
  "sourceLabel": "Official announcement"
}
```

JSON does not support comments, so do not paste commented-out JSON into `data/latest.json`. For scheduled runs, the same metadata can be enabled through the commented environment variables in `.github/workflows/scrape.yml`.
