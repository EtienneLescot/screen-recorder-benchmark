# Credits

The benchmark runs on public footage so that every machine measures the same bytes. Those clips
are other people's work, under licences that ask for attribution. This file is that attribution,
and it is generated from `sources.json` by `node bench.mjs credits` — if you add a bundle, add
it there and regenerate.

## commons-upload

**Screen track** — [Wikimedia Commons media upload guide (screen recording).webm](https://commons.wikimedia.org/wiki/File:Wikimedia_Commons_media_upload_guide_(screen_recording).webm)
by Status 401, via Wikimedia Commons. Licensed **CC BY 4.0**.

**Camera track** — [Introduction to Maryana Iskander (extended).webm](https://commons.wikimedia.org/wiki/File:Introduction_to_Maryana_Iskander_(extended).webm)
by Victor Grigas, via Wikimedia Commons. Licensed **CC BY-SA 4.0**.

No clip is redistributed by this repository. They are downloaded at run time, verified against
the hashes in `sources.json`, and normalised locally; the exports made from them are not
published.

---

The generated fixture (`lib/fixture.mjs`, `lib/assets.mjs`) is original to this repository and
carries no third-party rights.
