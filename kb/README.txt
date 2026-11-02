Drop plain-text knowledge base sources here (.txt / .md / .csv / .json) for engine.js.
Binary formats (PDF, DOCX, XLSX) should be parsed via the web app instead:
build the knowledge base in index.html, then Settings > Workspace file > Export and place
countersign-data.json next to engine.js (or in the web root for the app itself).
Documents pushed via POST /ingest are also persisted into this folder.
Note: engine.js deliberately skips this README.txt and any countersign-data.json
found in this folder when indexing.
