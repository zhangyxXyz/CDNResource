# Statistics map snapshots

Downloaded on 2026-09-17. The precise upstream URLs, versions, timestamps and SHA-256 hashes are recorded in `sources.json`.

- `china-1.6.3-full.json`: GeoJSON.cn China dataset **1.6.3**, published **2025-12-14**, the current published version checked on retrieval. Source: <https://geojson.cn/data/atlas/china>, full `100000.json` presentation. Upstream metadata, all polygon coordinates and the ten-dash line are preserved at their original positions. For hover labels only, Hainan polygons wholly south of 18°N are separated into a display-only “南海诸岛” feature; no province code or invented visit count is assigned to it. This changes display grouping, not administrative boundaries or coordinates. Coordinates: GCJ-02, per the publisher. Copyright (c) 2025 GeoJSON.CN; provincial data is offered freely through its API.
- `world-ne-5.1.2.json`: Natural Earth **Admin 0 countries 5.1.1**, from the **v5.1.2** release. Source: <https://www.naturalearthdata.com/downloads/110m-cultural-vectors/>. Public domain: <https://www.naturalearthdata.com/about/terms-of-use/>. All 177 geometries are preserved; unused attributes are removed. Display names use ISO region names where available, with original Chinese and English names retained for API matching. Coordinates: WGS84.

Natural Earth `LABEL_X` / `LABEL_Y` are retained as ECharts `cp` label anchors, avoiding bounding-box centers displaced by overseas territories or the date line. China `center` is adapted to `cp` at load time.

These are schematic analytics maps. The two datasets are rendered independently and are not spatially overlaid. Source version dates are not a claim that every boundary was surveyed on that date.

The blog maintenance command `node toolbox/update-statistics-maps.mjs` refreshes these snapshots from the pinned sources. Updating to a newer release requires first checking the publisher's changelog and then changing the pinned version. Normal builds make no requests to these map providers. Do not overwrite old vendor files under `static/npm/echarts@4.9.0/`.
