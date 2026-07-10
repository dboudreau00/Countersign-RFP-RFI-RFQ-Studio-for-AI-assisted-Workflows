Drop plain-text knowledge base sources here (.txt / .md / .csv / .json) for engine.js.
Binary formats (PDF, DOCX, XLSX) should be parsed via the web app instead:
build the bucket in index.html, then "Export workspace file" and place
countersign-data.json next to engine.js (or in the web root for the app itself).
Documents pushed via POST /ingest are also persisted into this folder.
