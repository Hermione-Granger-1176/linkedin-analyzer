# Large-export investigation, October 2026

This report records measurements from October 16 and 17, 2026, during changes to upload processing, storage, and exports. It preserves intermediate results and limitations. Statements about limits and worker behavior describe the measured stage, unless stated otherwise. Use [browser limits](web-app.md#check-browser-limits) for current behavior and [testing](testing.md#run-local-checks-and-benchmarks) for commands.

These results have not been rerun as part of the documentation revision. The original measurements used different readiness checks at different stages. The correction is recorded beside the affected results, so those timings and peaks do not form a controlled comparison across every stage.

## Initial baselines

The initial measurements were recorded on 2026-10-16 at commit `aeaaa15`, before the upload-processing changes. The machine had a 4-core Intel Xeon at 2.10 GHz and 15 GB RAM. The tools were headless Chromium 141.0.7390.37 and Node 24.15.0.

Each row contains three runs of `make bench-browser size_mb=N runs=3` with the listed options and synthetic data from `make gen-large-export`. Values are medians with ranges in parentheses. Peak heap combines sampled JavaScript heap from the page and its workers. No run crashed or failed to finish.

Messages time starts at file drop and includes opening Analytics first. These measurements also included the cached filter change before opening Messages. That change took at most a few hundred milliseconds. The benchmark later moved the filter check after Messages.

| Size  | Options | Analytics ready    | Messages ready       | Cached filter    | Peak heap        |
| ----- | ------- | ------------------ | -------------------- | ---------------- | ---------------- |
| 10 MB | `cpu=1` | 1.59 s (1.31-1.79) | 2.00 s (1.72-2.21)   | 176 ms (170-179) | 73 MB (69-90)    |
| 10 MB | `cpu=4` | 2.22 s (1.96-2.23) | 2.87 s (2.47-2.91)   | 168 ms (167-281) | 78 MB (70-88)    |
| 10 MB | `cpu=6` | 3.07 s (3.00-3.18) | 4.05 s (3.80-4.26)   | 262 ms (231-410) | 83 MB (79-96)    |
| 10 MB | `gpu=0` | 1.69 s (1.13-1.70) | 2.09 s (1.58-2.11)   | 178 ms (140-193) | 81 MB (70-100)   |
| 30 MB | `cpu=1` | 2.43 s (2.40-2.69) | 2.84 s (2.81-3.16)   | 186 ms (173-208) | 204 MB (196-204) |
| 30 MB | `cpu=4` | 3.48 s (3.28-3.51) | 4.19 s (3.92-4.27)   | 209 ms (190-274) | 247 MB (227-257) |
| 30 MB | `cpu=6` | 4.89 s (4.79-5.29) | 5.83 s (5.64-6.22)   | 306 ms (287-323) | 247 MB (203-251) |
| 30 MB | `gpu=0` | 2.57 s (2.46-2.64) | 2.98 s (2.91-3.24)   | 224 ms (162-292) | 204 MB (186-213) |
| 55 MB | `cpu=1` | 3.48 s (3.30-3.74) | 3.85 s (3.72-4.21)   | 181 ms (157-207) | 359 MB (355-359) |
| 55 MB | `cpu=4` | 5.77 s (5.57-5.78) | 6.43 s (6.30-6.55)   | 224 ms (193-241) | 475 MB (464-618) |
| 55 MB | `cpu=6` | 9.38 s (7.44-9.39) | 10.38 s (8.26-10.42) | 267 ms (254-282) | 436 MB (418-440) |
| 55 MB | `gpu=0` | 3.49 s (3.44-3.59) | 3.90 s (3.84-3.94)   | 152 ms (94-204)  | 359 MB (349-397) |

What the baselines show:

- Peak heap grows about 6.4 MB per MB of export between 10 and 55 MB, and a 55 MB export already peaks near 360 MB, over the provisional 300 MB budget. Reducing whole-file copies and retained analysis state matters more than speed.
- Throttled runs report higher peaks. The likely cause is that slower runs let the 200 ms sampler catch more short-lived allocations; this was not measured separately.
- CPU throttling reaches only the main thread, so the throttled timings are a lower bound for a slow device.
- Disabling the GPU produced no measurable change. No screen used WebGL at this stage.

The investigation began with shared upload limits, then moved file reads and streaming analytics into the worker. Later changes stored message events in typed arrays, bounded exports, and replaced stored text with `Blob` records. The sections below preserve the measurements from those stages.

At 100 MB, measured with the `measurement` build's higher limits before the worker read uploaded files directly, on the same machine. `cpu=1` is 3 runs; `cpu=4` and `cpu=6` are one run each:

| Size   | Options | Analytics ready     | Messages ready      | Cached filter    | Peak heap         |
| ------ | ------- | ------------------- | ------------------- | ---------------- | ----------------- |
| 100 MB | `cpu=1` | 7.62 s (7.20-10.67) | 8.05 s (7.65-11.14) | 174 ms (163-184) | 934 MB (919-1101) |
| 100 MB | `cpu=4` | 10.68 s             | 11.35 s             | 206 ms           | 945 MB            |
| 100 MB | `cpu=6` | 13.43 s             | 14.31 s             | 280 ms           | 833 MB            |

- At 100 MB the workers hold about 800 MB of the peak and the page about 150 MB, roughly three times the 300 MB budget. Heap grows faster than linearly between 55 and 100 MB.
- The Python CLI peaks at 1.44 GB RSS on a 107 MiB `messages.csv` from a 128 MiB synthetic export (`make audit-memory-python`), 399 MB on its 10.7 MiB `Connections.csv`, and under 200 MB on the shares and comments files.

After the analytics worker began reading uploaded files directly, 3 runs at `cpu=1` on the same machine and export:

| Size   | Options | Analytics ready    | Messages ready     | Cached filter    | Peak heap          |
| ------ | ------- | ------------------ | ------------------ | ---------------- | ------------------ |
| 100 MB | `cpu=1` | 7.09 s (7.09-7.24) | 7.54 s (7.53-7.72) | 179 ms (144-188) | 1000 MB (997-1001) |

- The workers now hold about 670 MB and the page about 330 MB. The page still receives the decoded text back from the worker for storage, so the total peak did not fall; the later switch to Blob storage removed that copy.

After the analytics worker began parsing and cleaning streamed chunks, 3 runs at `cpu=1` on the same machine and export:

| Size   | Options | Analytics ready    | Messages ready     | Cached filter    | Peak heap           |
| ------ | ------- | ------------------ | ------------------ | ---------------- | ------------------- |
| 100 MB | `cpu=1` | 6.34 s (6.15-7.04) | 6.79 s (6.59-7.44) | 155 ms (155-185) | 1177 MB (1174-1181) |

- Analytics is about 0.75 s faster, but the workers now peak near 845 MB. Cleaned cells are slices of the decoded chunks, so the chunks stay alive, and the worker still joins them into one more full string to return to the page. The later switch to Blob storage stopped returning the text and removed that copy.

After storage switched to `Blob` records read directly by workers, 3 runs at `cpu=1` on the same machine and export:

| Size   | Options | Analytics ready    | Messages ready     | Cached filter    | Peak heap        |
| ------ | ------- | ------------------ | ------------------ | ---------------- | ---------------- |
| 100 MB | `cpu=1` | 7.99 s (7.64-8.29) | 8.40 s (8.12-8.60) | 180 ms (108-196) | 589 MB (585-593) |

- The peak halved from 1177 MB after streaming analytics and is 37% below the 934 MB initial baseline. The page now holds about 6 MB at the peak, down from 330 MB: it never holds file text.
- The workers still peak near 585 MB, about twice the provisional 300 MB budget, so the public limits remained unchanged at that stage. The rest is the decoded text and cleaned rows inside the parsing workers.
- Analytics is about 5% slower than the initial baseline at 100 MB and 1.6 s slower than after streaming analytics, because the Messages screen's worker now reads the stored file itself rather than receiving text.

After the Clean, Messages, and PDF thread workers stream the stored file through the cleaner and the Messages worker exits once it answers, measured on 2026-10-17 on the same machine. Earlier rows timed "Messages ready" against the skeleton rows shown while the screen loads, so their Messages times and peaks were taken too early; these rows wait for real contact rows. The `cpu=1` rows are 3 runs; the 128 MB rows are one run each:

| Size   | Options          | Analytics ready | Messages ready | Peak heap |
| ------ | ---------------- | --------------- | -------------- | --------- |
| 55 MB  | `cpu=1`          | 3.41 s          | 7.30 s         | 177 MB    |
| 100 MB | `cpu=1`          | 4.58 s          | 10.58 s        | 199 MB    |
| 100 MB | `cpu=6 mobile=1` | 6.10 s          | 15.0 s         | 238 MB    |
| 128 MB | `cpu=1`          | 5.90 s          | 15.68 s        | 353 MB    |

- 100 MB now peaks at 199 MB, a third of the 589 MB after Blob storage and inside the 300 MB budget.
- 128 MB goes over the budget, mostly in the Messages worker, which needs every row to detect the self account and so cannot clean while it streams. The public limits stayed at 80 MiB until that worker shrank, below.
- Only Chromium is measured here; WebKit runs the end-to-end tests in CI but has no heap sampler.

After the streaming cleaner stores each repeated cell value once (`web/src/features/cleaning/string-pool.js`), measured on 2026-10-17 on the same machine. The first pooling row looked each value up after cleaning it; the second looks the raw value up first, cleans straight from the parser's cells, and takes a fast path for standard dates. Each pooling row was measured alongside a no-pooling run, since the machine's speed drifted during the day:

| Size   | Options                 | Analytics ready | Messages ready | Peak heap |
| ------ | ----------------------- | --------------- | -------------- | --------- |
| 100 MB | no pooling              | 5.58 s          | 12.51 s        | 189 MB    |
| 100 MB | pooling after cleaning  | 6.06 s          | 13.19 s        | 149 MB    |
| 100 MB | no pooling (`d82c5cf`)  | 4.47 s          | 10.33 s        | 239 MB    |
| 100 MB | pooling before cleaning | 4.14 s          | 9.06 s         | 124 MB    |

- Most of the cleaned rows' memory is the cell strings, and names, profile URLs, conversation ids and folders repeat on row after row. Sharing them cuts the rows a worker keeps for a 58 MiB `messages.csv` from 212 MB to 47 MB.
- Each column checks every window of 4,096 values and stops caching once a window is nearly all distinct, as dates and message bodies are.
- Looking values up after cleaning cost about 10%. Looking the raw value up first skips cleaning every repeat, and with the date fast path and no intermediate record object per row, the clean of that file in Node fell from about 2.2 s to 1.9 s.
- The date fast path does two time zone lookups instead of six and gave the same output as the general path on about 10 million inputs across 13 time zones, including historical offsets with seconds, which it hands back to the general path.
- A 128 MB export fits the 300 MB budget for analysis (198 MB with pooling after cleaning), so the public limits rose to 128 MiB per file, 128 Mi characters, and 1,000,000 rows.

## Retained analysis state

`make audit-state` forces garbage collection around each step and reports how many bytes of heap and array-buffer memory each structure keeps alive. It loads the web modules in `measurement` mode, so a 100 MB export passes the raised limits. Cleaned rows are transient: a worker holds them only while it builds state. The page keeps the message and connection state, and the analytics worker keeps its analytics state for filter changes. Field rows show what dropping that field frees, in table order.

These measurements used synthetic exports on the same machine on 2026-10-16, after message events moved to typed arrays. **Before arrays** shows the earlier results for a 100 MB export.

| Structure                    | 10 MB   | 55 MB   | 100 MB   | Before arrays |
| ---------------------------- | ------- | ------- | -------- | ------------- |
| Cleaned message rows         | 14.0 MB | 76.9 MB | 138.7 MB | 138.6 MB      |
| Cleaned connection rows      | 2.5 MB  | 13.4 MB | 24.8 MB  | 24.8 MB       |
| Cleaned share rows           | 1.3 MB  | 6.8 MB  | 11.1 MB  | 11.1 MB       |
| Cleaned comment rows         | 0.7 MB  | 3.7 MB  | 5.8 MB   | 5.8 MB        |
| Page message and connections | 6.7 MB  | 23.6 MB | 39.0 MB  | 104.9 MB      |
| Connection state             | 3.2 MB  | 17.2 MB | 31.1 MB  | 31.1 MB       |
| Message events               | 0.8 MB  | 2.6 MB  | 4.4 MB   | 64.8 MB       |
| Message row timestamps       | 0.3 MB  | 1.5 MB  | 2.7 MB   | 8.1 MB        |
| Message contacts             | 1.2 MB  | 1.2 MB  | 1.2 MB   | 1.2 MB        |
| Analytics state              | 3.4 MB  | 10.3 MB | 17.7 MB  | 17.7 MB       |

- Storing message events as typed-array columns cut the page's message state at 100 MB from 105 MB to 39 MB. Events went from one object per message to an `Int32Array` of contact IDs and a `Float64Array` of timestamps, which the worker transfers instead of copying.
- Cleaned message rows are the largest structure, about 1.65 bytes of heap per byte of `messages.csv`. They live only inside the messages worker, so they set its peak, not the page's.
- The connection state is now the largest thing the page keeps.

## Export memory

The export measurements were recorded on 2026-10-16 after message events moved to typed arrays. Each export used one run at `cpu=1`. The **With Blobs** column contains medians of two later runs on a 100 MB export after storage switched to `Blob` records.

The benchmark's `export=excel` option downloads a cleaned `messages.csv` workbook from the Clean screen after Messages is ready. The `export=pdf` option includes message bodies, while `export=pdf-summary` excludes them. Results include export time and the combined peak heap of the page and all active workers.

| Export      | 10 MB export   | 30 MB export   | 100 MB export    | With Blobs      |
| ----------- | -------------- | -------------- | ---------------- | --------------- |
| Excel       | 2.62 s, 191 MB | 7.64 s, 610 MB | 29.22 s, 1281 MB | refused         |
| PDF, bodies | 2.47 s, 162 MB | 5.75 s, 458 MB | 18.08 s, 1114 MB | 19.26 s, 648 MB |
| PDF summary | not measured   | not measured   | 15.00 s, 1927 MB | 12.94 s, 599 MB |

- The Excel workbook costs about 25 MB of heap per MB of `messages.csv`, which the page held when this was measured and the Clean screen's worker holds now, so it would pass the 300 MB budget only up to about 12 MB. The Clean screen now builds workbooks only for files up to 10 MiB, says why for larger ones, and offers a cleaned CSV that it writes in 2,000-row parts into a `Blob`, so no single string holds the whole file.
- Before Blob storage both PDF exports went over the budget at 100 MB, with or without message bodies. Most of the peak was the stored text read back from IndexedDB and the analysis workers still alive, not the bodies.
- After Blob storage the PDF export adds about 60 MB with message bodies and about 10 MB without them over the 589 MB analysis peak, and the page holds about 80 MB during the export. At this stage, the analysis workers set the peak. The export had no separate size limit yet.
- After the streaming work, a 100 MB export with an 80 MiB `messages.csv` peaked at 367 MB with message bodies, because the bodies are held alongside the analysis. The PDF export now refuses message contents for a `messages.csv` above 60 MiB and says to untick them; a 73 MB export with a 58.4 MiB `messages.csv` peaks at 220 MB and finishes in 9.6 s. Without bodies the 100 MB export peaks at 276 MB (median, 313 MB worst run), and at 128 MB it reaches 397 MB.
- The thread worker then picks the threads from rows without bodies, sharing repeated values, and reads the file a second time for only the bodies it picked, so the output is unchanged. With the cleaner's pooling, the 73 MB export with bodies peaks at 213 MB, down from 333 MB on the same probe. Without bodies the 100 MB export peaks at 190 to 214 MB in 7 to 8 s, and the 128 MB export at 135 MB. With bodies the 100 MB export would peak at 268 to 303 MB and the 128 MB export at 329 MB, so the 60 MiB limit on message contents stays.

## Clean screen main-thread time

The Clean screen builds its preview, Excel workbook, and cleaned CSV in a worker. Measured on 2026-10-16 with a Playwright script that is not part of the repository, on the 55 MB synthetic export at a CPU throttle of 4: each row selects a file type on the Clean screen, then downloads the workbook and the CSV, and reports the longest main-thread task the browser recorded.

| File type   | Longest task before | Longest task after | Excel before | Excel after |
| ----------- | ------------------- | ------------------ | ------------ | ----------- |
| Shares      | 2,597 ms            | 58 ms              | 3.6 s        | 1.5 s       |
| Comments    | 1,431 ms            | 0 ms               | 2.3 s        | 1.3 s       |
| Connections | 7,225 ms            | 0 ms               | 8.7 s        | 3.0 s       |
| Messages    | 2,827 ms            | 0 ms               | refused      | refused     |

- The longest task before was the workbook build for every type but Messages, whose file is over the Excel limit; its longest task was the cleaned CSV.
- The 58 ms task after is the first visit to the Clean screen, which loads that screen's code. No task reached the 50 ms long-task threshold after that.
- Downloads are faster because the worker reuses the rows it cleaned for the preview instead of parsing the file again.
