// Overlay tiles drawn from vector tiles: streets, paths, borders, rivers, ridges, peaks and place names on top of
// the satellite imagery. The tiles are from OpenFreeMap (OpenMapTiles schema, no api key needed, data
// © OpenStreetMap contributors under ODbL, schema © OpenMapTiles). Decoding and drawing run in a worker on an
// OffscreenCanvas, the main thread only gets the finished ImageBitmap.
// Registers itself as tile source for urls "vector:z/x/y", has to be loaded after virtual_texture.js

/**
 * @brief code running in the worker, it is converted to a string, so it must not use anything from outside
 */
const vector_tile_worker_main = () => {
    const tilejson_url = "https://tiles.openfreemap.org/planet";
    const tile_size = 256;
    const max_cached_tiles = worker_cached_tiles;   // decoded source tiles, a z14 tile is used for all overzoomed tiles below it
    const used_layers = new Set(["boundary", "transportation", "transportation_name", "mountain_peak", "place", "waterway", "poi"]);
    const text_decoder = new TextDecoder();

    // ---------------------------------------------------------------------------------------------------------
    // protobuf / mvt decoding, see https://github.com/mapbox/vector-tile-spec/tree/master/2.1
    // ---------------------------------------------------------------------------------------------------------
    const read_varint = (r) => {
        let v = 0, shift = 0, b;
        do {
            b = r.buf[r.pos++];
            v += (b & 0x7f) * 2 ** shift;
            shift += 7;
        } while (b & 0x80);
        return v;
    };
    const read_bytes = (r) => {
        const l = read_varint(r);
        const bytes = r.buf.subarray(r.pos, r.pos + l);
        r.pos += l;
        return bytes;
    };
    const skip = (r, wire) => {
        if (wire == 0) read_varint(r);
        else if (wire == 1) r.pos += 8;
        else if (wire == 2) read_bytes(r);
        else if (wire == 5) r.pos += 4;
        else throw new Error(`unknown wire type ${wire}`);
    };
    // calls f(field, wire, reader) for each field of the message in buf
    const for_fields = (buf, f) => {
        const r = {buf, pos: 0};
        while (r.pos < buf.length) {
            const tag = read_varint(r);
            const start = r.pos;
            f(tag >> 3, tag & 7, r);
            if (r.pos == start)
                skip(r, tag & 7);
        }
    };
    const read_packed = (bytes) => {
        const r = {buf: bytes, pos: 0};
        const vals = [];
        while (r.pos < bytes.length)
            vals.push(read_varint(r));
        return vals;
    };
    const zigzag = (v) => v % 2 ? -(v + 1) / 2 : v / 2;
    const read_value = (bytes) => {
        let v = null;
        const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        for_fields(bytes, (field, wire, r) => {
            if (field == 1) v = text_decoder.decode(read_bytes(r));
            else if (field == 2) { v = view.getFloat32(r.pos, true); r.pos += 4; }
            else if (field == 3) { v = view.getFloat64(r.pos, true); r.pos += 8; }
            else if (field == 4) { v = read_varint(r); if (v >= 2 ** 63) v -= 2 ** 64; }
            else if (field == 5) v = read_varint(r);
            else if (field == 6) v = zigzag(read_varint(r));
            else if (field == 7) v = read_varint(r) != 0;
        });
        return v;
    };
    // geometry as list of parts with flat [x0, y0, x1, y1, ...] coordinates, each point of a multipoint is its own part
    const decode_geometry = (cmds, type) => {
        const parts = [];
        let x = 0, y = 0, part = null;
        let bbox = [Infinity, Infinity, -Infinity, -Infinity];
        for (let i = 0; i < cmds.length;) {
            const cmd = cmds[i] & 7, count = Math.floor(cmds[i] / 8);
            ++i;
            if (cmd == 7) {
                if (part && part.length >= 2)
                    part.push(part[0], part[1]);
                continue;
            }
            for (let c = 0; c < count; ++c) {
                x += zigzag(cmds[i++]);
                y += zigzag(cmds[i++]);
                if (cmd == 1 || type == 1) {
                    part = [];
                    parts.push(part);
                }
                part.push(x, y);
                bbox = [Math.min(bbox[0], x), Math.min(bbox[1], y), Math.max(bbox[2], x), Math.max(bbox[3], y)];
            }
        }
        return {parts, bbox};
    };
    const decode_layer = (bytes) => {
        const layer = {name: "", extent: 4096, keys: [], values: [], raw_features: [], features: []};
        for_fields(bytes, (field, wire, r) => {
            if (field == 1) layer.name = text_decoder.decode(read_bytes(r));
            else if (field == 2) layer.raw_features.push(read_bytes(r));
            else if (field == 3) layer.keys.push(text_decoder.decode(read_bytes(r)));
            else if (field == 4) layer.values.push(read_value(read_bytes(r)));
            else if (field == 5) layer.extent = read_varint(r);
        });
        if (!used_layers.has(layer.name))
            return null;
        for (const raw of layer.raw_features) {
            let tags = [], type = 0, geometry = [];
            for_fields(raw, (field, wire, r) => {
                if (field == 2) tags = read_packed(read_bytes(r));
                else if (field == 3) type = read_varint(r);
                else if (field == 4) geometry = read_packed(read_bytes(r));
            });
            const props = {};
            for (let t = 0; t + 1 < tags.length; t += 2)
                props[layer.keys[tags[t]]] = layer.values[tags[t + 1]];
            layer.features.push({type, props, ...decode_geometry(geometry, type)});
        }
        layer.raw_features = null;
        // the features reach this far over the tile border into the neighbor tiles (larger for labels than for lines)
        layer.buffer = 0;
        for (const f of layer.features)
            layer.buffer = Math.max(layer.buffer, -f.bbox[0], -f.bbox[1], f.bbox[2] - layer.extent, f.bbox[3] - layer.extent);
        return layer;
    };
    const decode_tile = (buf) => {
        const layers = {};
        for_fields(buf, (field, wire, r) => {
            if (field != 3)
                return;
            const layer = decode_layer(read_bytes(r));
            if (layer)
                layers[layer.name] = layer;
        });
        return {layers, label_layouts: new Map()};
    };

    // ---------------------------------------------------------------------------------------------------------
    // loading
    // ---------------------------------------------------------------------------------------------------------
    let tilejson = null;
    const get_tilejson = () => {
        if (!tilejson)
            tilejson = fetch(tilejson_url).then(r => { if (!r.ok) throw new Error(`tilejson ${r.status}`); return r.json(); })
                                          .catch(e => { tilejson = null; throw e; });
        return tilejson;
    };
    const cache = new Map();    // "z/x/y" -> Promise of the decoded tile, in lru order
    const get_tile = (z, x, y) => {
        const key = `${z}/${x}/${y}`;
        let p = cache.get(key);
        if (p) {
            cache.delete(key);
            cache.set(key, p);
            return p;
        }
        p = get_tilejson().then(tj => fetch(tj.tiles[0].replace("{z}", z).replace("{x}", x).replace("{y}", y)))
            .then(async r => {
                if (!r.ok)
                    throw new Error(`tile ${key}: ${r.status}`);
                let buf = new Uint8Array(await r.arrayBuffer());
                // usually decompressed by the browser already (content-encoding), raw gzip is decompressed here
                if (buf[0] == 0x1f && buf[1] == 0x8b)
                    buf = new Uint8Array(await new Response(new Blob([buf]).stream().pipeThrough(new DecompressionStream("gzip"))).arrayBuffer());
                return {...decode_tile(buf), z, x, y};
            });
        p.catch(() => cache.delete(key));
        cache.set(key, p);
        while (cache.size > max_cached_tiles)
            cache.delete(cache.keys().next().value);
        return p;
    };

    // ---------------------------------------------------------------------------------------------------------
    // names of buildings and places (e.g. farm names like "Lachl", forests) from the 3d labels of the Bayerische
    // Vermessungsverwaltung (geodaten.bayern.de, the tile schemas leave them out). The labels are a 3d tiles tileset of
    // vector tiles (vctr) with one point per name, only in bavaria. They are loaded for areas of a zoom 13 tile, the
    // tileset files are traversed down to the label tiles of the area, the results are kept in the cache storage
    // ---------------------------------------------------------------------------------------------------------
    const housename_z = 13;
    const housename_src_z = 14;             // only the source tiles of this level get the names
    const housename_margin = 1 / 8;         // of a source tile, names this far outside are kept for labels reaching over the border
    const bayern_labels_url = "https://bvv3d22.bayernwolke.de/3d-data/latest/labels3d/tileset.json";
    const bayern_label_skip = new Set(["strassenname"]);    // the streets have their names from the vector tiles
    const housename_cache_ms = 30 * 24 * 3600 * 1000;
    const housename_retry_ms = 60000;       // doubled after each failure of an area, up to housename_max_retry_ms
    const housename_max_retry_ms = 30 * 60000;
    const housenames = new Map();           // "x/y" of the zoom 13 tile -> {state: "loading"|"ready"|"failed", names: [{x, y, name, kind}] in uv, time, failures}
    const housename_queue = [];
    let housename_busy = false;
    const tile_lon = (x, n) => x / n * 360 - 180;
    const tile_lat = (y, n) => Math.atan(Math.sinh(Math.PI * (1 - 2 * y / n))) * 180 / Math.PI;
    try {
        caches.delete("gpx-housenames-v1");     // names of the earlier sources (own server, overpass)
    } catch (e) {}
    const tilesets = new Map();             // url -> promise of the parsed tileset file
    const load_tileset = (url) => {
        if (!tilesets.has(url))
            tilesets.set(url, fetch(url).then(r => {
                if (!r.ok)
                    throw new Error(`${url}: ${r.status}`);
                return r.json();
            }).catch(e => {
                tilesets.delete(url);   // tried again with the next request of the area
                throw e;
            }));
        return tilesets.get(url);
    };
    /** @returns {Promise<Array<string>>} urls of the contents of the tileset (all levels) whose region intersects rect [west, south, east, north] in radians */
    const tileset_contents_in = async (tileset_url, rect) => {
        const out = [];
        const visit = async (node, base) => {
            const r = node.boundingVolume && node.boundingVolume.region;
            if (r && (r[0] > rect[2] || r[2] < rect[0] || r[1] > rect[3] || r[3] < rect[1]))
                return;
            const tasks = [];
            const c = node.content && (node.content.uri || node.content.url);
            if (c) {
                const url = new URL(c, base).href;
                if (/\.json(\?|$)/.test(url))
                    tasks.push(load_tileset(url).then(t => visit(t.root, url)));
                else
                    out.push(url);
            }
            for (const child of node.children || [])
                tasks.push(visit(child, base));
            await Promise.all(tasks);
        };
        await visit((await load_tileset(tileset_url)).root, tileset_url);
        return out;
    };
    /**
     * @brief points of a cesium vector tile (vctr): header of 11 uint32, feature table, batch table, then the indices and
     * positions of the polygons, polylines and points. The point positions are zig zag delta encoded uint16 u, v, height
     * arrays in the rectangle of the tile
     * @returns {Array<{lon, lat, props}>} lon, lat in degrees, props the batch table values of the point
     */
    const decode_vctr_points = (buf) => {
        const dv = new DataView(buf);
        if (dv.getUint32(0, true) != 0x72746376)    // "vctr"
            throw new Error("no vctr tile");
        const [ftj, ftb, btj, btb, indices, polygons, polylines] = [3, 4, 5, 6, 7, 8, 9].map(i => dv.getUint32(4 * i, true));
        let o = 44;
        const ft = JSON.parse(text_decoder.decode(new Uint8Array(buf, o, ftj)));
        o += ftj + ftb;
        const bt = btj ? JSON.parse(text_decoder.decode(new Uint8Array(buf, o, btj))) : {};
        o += btj + btb + indices + polygons + polylines;
        const n = ft.POINTS_LENGTH || 0;
        if (!n || ft.POINT_BATCH_IDS)   // own batch ids are not used by these tiles
            return [];
        const q = new Uint16Array(buf.slice(o, o + 6 * n));    // copied, the offset is not aligned
        const [west, south, east, north] = ft.RECTANGLE;
        // without batch ids the polygons and polylines have the first ones
        const first_batch = (ft.POLYGONS_LENGTH || 0) + (ft.POLYLINES_LENGTH || 0);
        const points = [];
        let u = 0, v = 0;
        for (let i = 0; i < n; ++i) {
            u += (q[i] >> 1) ^ -(q[i] & 1);
            v += (q[n + i] >> 1) ^ -(q[n + i] & 1);
            const props = {};
            for (const k in bt)
                if (Array.isArray(bt[k]))
                    props[k] = bt[k][first_batch + i];
            points.push({lon: (west + u / 32767 * (east - west)) * 180 / Math.PI, lat: (south + v / 32767 * (north - south)) * 180 / Math.PI, props});
        }
        return points;
    };
    const fetch_housenames = async (x, y) => {
        const n = 2 ** housename_z, m = housename_margin / 2;
        const rad = Math.PI / 180;
        const rect = [tile_lon(x - m, n) * rad, tile_lat(y + 1 + m, n) * rad, tile_lon(x + 1 + m, n) * rad, tile_lat(y - m, n) * rad];
        const to_uv = (lon, lat) => ({x: (lon + 180) / 360, y: (1 - Math.asinh(Math.tan(lat * Math.PI / 180)) / Math.PI) / 2});
        let cache = null;
        try {
            cache = await caches.open("gpx-housenames-bayern-v1");
        } catch (e) {}
        const key = `https://housenames.invalid/${housename_z}/${x}/${y}`;
        if (cache) {
            const r = await cache.match(key);
            if (r && Date.now() - +r.headers.get("x-fetched") < housename_cache_ms)
                return r.json();
        }
        const urls = await tileset_contents_in(bayern_labels_url, rect);
        const tiles = await Promise.all(urls.map(async (url) => {
            const r = await fetch(url);
            if (!r.ok)
                throw new Error(`${url}: ${r.status}`);
            return decode_vctr_points(await r.arrayBuffer());
        }));
        const names = [];
        for (const points of tiles)
            for (const {lon, lat, props} of points)
                if (props.name && !bayern_label_skip.has(props.objektart))
                    names.push({...to_uv(lon, lat), name: String(props.name), kind: props.objektart || ""});
        if (cache) {
            try {
                await cache.put(key, new Response(JSON.stringify(names), {headers: {"x-fetched": String(Date.now())}}));
            } catch (e) {}
        }
        return names;
    };
    const pump_housenames = async () => {
        if (housename_busy || !housename_queue.length)
            return;
        housename_busy = true;
        const [x, y, h] = housename_queue.pop();
        try {
            h.names = await fetch_housenames(x, y);
            h.state = "ready";
            // the main thread renders the tiles of the area again
            self.postMessage({event: "housenames", z: housename_z, x, y});
        } catch (e) {
            console.warn(`building names of ${housename_z}/${x}/${y} could not be loaded: ${e.message}`);
            h.state = "failed";
            h.time = Date.now();
            h.failures = (h.failures || 0) + 1;
        }
        housename_busy = false;
        pump_housenames();
    };
    /** @returns {Array|null} the names of the zoom 13 tile, null while they are loading (the loading is started) or failed (retried later) */
    const get_housenames = (x, y) => {
        const key = `${x}/${y}`;
        let h = housenames.get(key);
        const retry_ms = h ? Math.min(housename_retry_ms * 2 ** ((h.failures || 1) - 1), housename_max_retry_ms) : 0;
        if (!h || (h.state == "failed" && Date.now() - h.time > retry_ms)) {
            h = {state: "loading", names: null, time: Date.now(), failures: h ? h.failures : 0};
            housenames.set(key, h);
            housename_queue.push([x, y, h]);
            pump_housenames();
        }
        return h.state == "ready" ? h.names : null;
    };
    /**
     * @returns {Array|null} names around the source tile as {x, y (tile fraction), name}, null while loading. Names of
     * points of interest of the tile are left out, they have their own label
     */
    const housenames_of_tile = (tile) => {
        const d = tile.z - housename_z;
        const names = get_housenames(tile.x >> d, tile.y >> d);
        if (!names)
            return null;
        const n = 2 ** tile.z;
        const known = new Set([...(tile.layers.poi ? tile.layers.poi.features : []), ...(tile.layers.place ? tile.layers.place.features : [])].map(f => name_of(f.props)));
        return names.map(h => ({x: h.x * n - tile.x, y: h.y * n - tile.y, name: h.name, kind: h.kind}))
                    .filter(h => h.x > -housename_margin && h.y > -housename_margin && h.x < 1 + housename_margin && h.y < 1 + housename_margin && !known.has(h.name));
    };

    // ---------------------------------------------------------------------------------------------------------
    // style, widths are in pixels of a 256 pixel tile at zoom 14 and grow with the zoom. Below zoom 14 the main roads
    // and rivers shrink slower (shrink: exponent per zoom level instead of .75) down to min_w, they stay visible zoomed out
    // ---------------------------------------------------------------------------------------------------------
    const road_styles = {
        motorway:  {w: 3.2, col: "#f39b5b", min_z: 0, shrink: .3, min_w: 1.6},
        trunk:     {w: 3.0, col: "#f7b469", min_z: 0, shrink: .3, min_w: 1.4},
        primary:   {w: 2.6, col: "#fcd277", min_z: 0, shrink: .35, min_w: 1.2},
        secondary: {w: 2.2, col: "#fff09a", min_z: 8, shrink: .45, min_w: .9},
        tertiary:  {w: 1.8, col: "#ffffff", min_z: 10, shrink: .6, min_w: .7},
        minor:     {w: 1.3, col: "#ffffff", min_z: 13},
        service:   {w: .8,  col: "#eeeeee", min_z: 14},
        track:     {w: 1.0, col: "#e8c27a", min_z: 12, dash: [4, 2]},
        path:      {w: .9,  col: "#ff6a4d", min_z: 13, dash: [3, 2]},
        cycleway:  {w: .9,  col: "#5aa8ff", min_z: 13, dash: [3, 2]},
        rail:      {w: 1.1, col: "#dddddd", min_z: 10, dash: [6, 3]},
        ferry:     {w: 1.0, col: "#7fc4ff", min_z: 8,  dash: [5, 4], no_casing: true},
    };
    const road_order = Object.keys(road_styles).reverse();  // the important roads are drawn last
    const road_style_name = (p) => {
        const cls = String(p.class || "").replace(/_construction$/, "");
        if (cls == "path" && p.subclass == "cycleway")
            return "cycleway";
        if (cls == "transit")
            return "rail";
        if (cls == "busway" || cls == "raceway")
            return "minor";
        return road_styles[cls] ? cls : null;
    };
    const waterway_styles = {river: {w: 1.8, min_z: 6, shrink: .3, min_w: 1.3}, canal: {w: 1.5, min_z: 9, shrink: .4, min_w: 1}, stream: {w: .8, min_z: 13},
                             ditch: {w: .5, min_z: 14}, drain: {w: .5, min_z: 14}};
    /** @returns {float} line width in tile pixels of a style with w (and optionally shrink, min_w) at zoom z */
    const style_width = (st, z, min_w) => Math.max(st.w * 2 ** ((z - 14) * (z < 14 && st.shrink ? st.shrink : .75)), st.min_w || min_w);
    const boundary_styles = [   // by admin level, country borders darker and thicker to tell them apart from the state borders
        {max_level: 2, w: 3.2, dash: [7, 3], min_z: 0,  col: "#5e0d80", casing: "rgba(240, 225, 250, .75)", grow: .5, shrink: .08, min_w: 2.6},
        {max_level: 4, w: 1.5, dash: [6, 3], min_z: 4,  col: "#d98cff", casing: "rgba(0, 0, 0, .5)", grow: .3, shrink: .1, min_w: 1.1},
        {max_level: 6, w: 1.1, dash: [4, 3], min_z: 9,  col: "#d98cff", casing: "rgba(0, 0, 0, .5)", grow: .3},
        {max_level: 8, w: .9,  dash: [3, 3], min_z: 12, col: "#d98cff", casing: "rgba(0, 0, 0, .5)", grow: .3},
    ];
    const place_styles = {
        city:              {font: "bold 15px sans-serif", min_z: 0},
        town:              {font: "bold 13px sans-serif", min_z: 8},
        village:           {font: "12px sans-serif", min_z: 11},
        suburb:            {font: "11px sans-serif", min_z: 12},
        hamlet:            {font: "11px sans-serif", min_z: 13},
        quarter:           {font: "11px sans-serif", min_z: 14},
        neighbourhood:     {font: "10px sans-serif", min_z: 15},
        locality:          {font: "italic 10px sans-serif", min_z: 14},
        isolated_dwelling: {font: "10px sans-serif", min_z: 15},
    };
    // named points of interest (huts, churches, restaurants, ...) for the close levels. Tier 1 is shown first, infrastructure
    // without a useful name (bus stops, parking, guideposts, ...) is left out
    const poi_tier_classes = [
        ["lodging:alpine_hut", "lodging:wilderness_hut", "place_of_worship", "castle", "town_hall", "railway", "aerialway", "attraction", "monument"],
        ["attraction:viewpoint", "lodging", "restaurant", "cafe", "beer", "bar", "fast_food", "ice_cream", "museum", "school", "college", "hospital", "library", "theatre",
         "cinema", "police", "fire_station", "post:post_office", "golf", "stadium", "swimming_pool", "zoo"],
        ["shop", "bakery", "butcher", "grocery", "clothing_store", "hairdresser", "bank", "pharmacy", "doctors", "dentist", "veterinary",
         "car", "fuel", "laundry", "office", "harbor", "campsite", "sports"],
    ];
    // "class:subclass" entries take precedence over the plain class (viewpoints are attractions with generic names)
    const poi_tier = (p) => {
        let i = poi_tier_classes.findIndex(list => list.includes(`${p.class}:${p.subclass}`));
        if (i < 0)
            i = poi_tier_classes.findIndex(list => list.includes(String(p.class)));
        return i < 0 ? null : i + 1;
    };
    const poi_min_z = [0, 15, 16, 17];          // per tier, on the ground
    const poi_max_dist_m = [0, 3000, 1500, 700]; // per tier, for the billboards in 3d
    // names of buildings and settlements with a house symbol, the others (forests, fields, ...) green without a symbol
    const housename_style = (h) => ["ortsname", "gemeindeteil", ""].includes(h.kind) ? {col: "#fff1dc", symbol: "house"} : {col: "#d8f5c8"};
    const housename_min_z = 16;               // on the ground
    const housename_max_dist_m = 1200;        // for the billboards in 3d
    const casing_col = "rgba(20, 20, 20, .85)";
    const halo_col = "rgba(0, 0, 0, .8)";
    const name_of = (p) => p["name:de"] || p.name_de || p.name || "";

    // draws the symbol and text of a label with its anchor at the origin of ctx
    const draw_label = (ctx, label) => {
        if (label.symbol == "peak") {
            ctx.beginPath();
            ctx.moveTo(0, -5); ctx.lineTo(4.5, 3); ctx.lineTo(-4.5, 3); ctx.closePath();
            ctx.fillStyle = "#ffcf8a";
            ctx.strokeStyle = "rgba(40, 20, 0, .9)";
            ctx.lineWidth = 1.2;
            ctx.fill();
            ctx.stroke();
        } else if (label.symbol == "saddle") {
            ctx.beginPath();
            ctx.arc(0, 0, 2.5, 0, 2 * Math.PI);
            ctx.fillStyle = "#ffcf8a";
            ctx.fill();
        } else if (label.symbol == "house") {
            ctx.fillStyle = "#ffe9c4";
            ctx.strokeStyle = "rgba(40, 25, 0, .9)";
            ctx.lineWidth = 1.2;
            ctx.fillRect(-3, -3, 6, 6);
            ctx.strokeRect(-3, -3, 6, 6);
        } else if (label.symbol == "poi") {
            ctx.beginPath();
            ctx.arc(0, 0, 3, 0, 2 * Math.PI);
            ctx.fillStyle = "#9fd0ff";
            ctx.strokeStyle = "rgba(0, 20, 40, .9)";
            ctx.lineWidth = 1.2;
            ctx.fill();
            ctx.stroke();
        }
        ctx.font = label.font;
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.lineJoin = "round";
        ctx.strokeStyle = halo_col;
        ctx.lineWidth = 3;
        ctx.strokeText(label.text, label.tx, label.ty);
        ctx.fillStyle = label.col;
        ctx.fillText(label.text, label.tx, label.ty);
    };

    // css color -> [r, g, b, a] (0-1), only the forms used in the styles
    const parse_color = (c) => {
        let m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(c);
        if (m)
            return [parseInt(m[1], 16) / 255, parseInt(m[2], 16) / 255, parseInt(m[3], 16) / 255, 1];
        m = /^rgba\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*\)$/.exec(c);
        return [m[1] / 255, m[2] / 255, m[3] / 255, +m[4]];
    };
    /**
     * @brief image rects of the labels (symbol at the anchor and the text) packed into one atlas image
     * @returns {{labels: Array, atlas: ImageBitmap|null}} the packed labels with w, h, ax, ay (anchor in the rect) and
     * atlas_x, atlas_y. Labels which do not fit (atlas at most 512 x max_h) are left out, the input is in priority order
     */
    const pack_labels = (labels, max_h) => {
        const mctx = new OffscreenCanvas(1, 1).getContext("2d");
        const atlas_w = 512;
        let cx = 0, cy = 0, row_h = 0;
        const packed = [];
        for (const label of labels) {
            mctx.font = label.font;
            const tw = Math.ceil(mctx.measureText(label.text).width);
            const th = parseInt(/(\d+)px/.exec(label.font)[1]);
            // rect around the anchor: text with its halo and the symbol at the anchor
            const sym = label.symbol ? 6 : 0;
            const x0 = Math.floor(Math.min(label.tx - tw / 2, -sym) - 3), x1 = Math.ceil(Math.max(label.tx + tw / 2, sym) + 3);
            const y0 = Math.floor(Math.min(label.ty - th / 2 - 3, -sym)), y1 = Math.ceil(Math.max(label.ty + th / 2 + 3, sym));
            const l = {...label, w: x1 - x0, h: y1 - y0, ax: -x0, ay: -y0};
            if (l.w > atlas_w)
                continue;
            if (cx + l.w > atlas_w) {
                cx = 0;
                cy += row_h;
                row_h = 0;
            }
            if (cy + l.h > max_h)
                break;
            l.atlas_x = cx;
            l.atlas_y = cy;
            cx += l.w;
            row_h = Math.max(row_h, l.h);
            packed.push(l);
        }
        if (!packed.length)
            return {labels: [], atlas: null};
        const canvas = new OffscreenCanvas(atlas_w, cy + row_h);
        const actx = canvas.getContext("2d");
        for (const l of packed) {
            actx.save();
            actx.translate(l.atlas_x + l.ax, l.atlas_y + l.ay);
            draw_label(actx, l);
            actx.restore();
        }
        return {labels: packed, atlas: canvas.transferToImageBitmap()};
    };

    /**
     * @brief drawing of a tile for the gpu (VectorTileGpu on the main thread): the line pieces in tile pixels and the
     * strokes in drawing order, each stroke draws a group of pieces with a color, width and dash pattern (as a canvas
     * path stroke with round caps and joins). The labels are sprites of an atlas, with_labels false leaves them out
     * (they are drawn as billboards in 3d then)
     * @returns {{pieces: Float32Array, groups: Array, strokes: Array, labels: Array, atlas: ImageBitmap|null}} pieces
     * [ax, ay, bx, by, along a, along b] with the length along the line in pixels for the dashes, groups {first, count}
     * of pieces, strokes {group, color: [r, g, b, a], width, dash: [on, off]} and labels {x, y, angle, w, h, ax, ay, atlas_x, atlas_y}
     */
    const build_tile_drawing = async (z, x, y, with_labels) => {
        const src_z = Math.min(z, (await get_tilejson()).maxzoom || 14);
        const dz = z - src_z;
        const sub = 2 ** dz;
        const tile = await get_tile(src_z, Math.floor(x / sub), Math.floor(y / sub));
        // the requested tile is a part of the source tile for zoom levels above the max zoom of the data
        const ox = (x - Math.floor(x / sub) * sub) * tile_size, oy = (y - Math.floor(y / sub) * sub) * tile_size;
        const zf = 2 ** ((z - 14) * .75);

        const scale_of = (layer) => tile_size * sub / layer.extent;
        const margin = 40;  // pixels, line widths reach over the pieces
        const visible = (f, s) => f.bbox[0] * s - ox < tile_size + margin && f.bbox[2] * s - ox > -margin &&
                                  f.bbox[1] * s - oy < tile_size + margin && f.bbox[3] * s - oy > -margin;
        const pieces = [];
        const groups = [];
        const strokes = [];
        // collects the line features of a layer into one group of pieces per style key
        const collect = (layer, key_of) => {
            const by_key = new Map();
            if (!layer)
                return new Map();
            const s = scale_of(layer);
            for (const f of layer.features) {
                if (f.type != 2 || !visible(f, s))
                    continue;
                const key = key_of(f.props);
                if (key == null)
                    continue;
                if (!by_key.has(key))
                    by_key.set(key, []);
                const out = by_key.get(key);
                for (const part of f.parts) {
                    let along = 0;
                    for (let i = 2; i < part.length; i += 2) {
                        const ax = part[i - 2] * s - ox, ay = part[i - 1] * s - oy, bx = part[i] * s - ox, by = part[i + 1] * s - oy;
                        const len = Math.hypot(bx - ax, by - ay);
                        if (Math.max(ax, bx) > -margin && Math.min(ax, bx) < tile_size + margin && Math.max(ay, by) > -margin && Math.min(ay, by) < tile_size + margin)
                            out.push(ax, ay, bx, by, along, along + len);
                        along += len;
                    }
                }
            }
            const result = new Map();
            for (const [key, out] of by_key) {
                if (!out.length)
                    continue;
                result.set(key, groups.length);
                groups.push({first: pieces.length / 6, count: out.length / 6});
                for (const v of out)
                    pieces.push(v);
            }
            return result;
        };
        const stroke = (group, col, w, dash, alpha = 1) => {
            const color = parse_color(col);
            color[3] *= alpha;
            strokes.push({group, color, width: w, dash: dash ? [dash[0], dash[1]] : [0, 0]});
        };

        // waterways
        for (const [cls, group] of collect(tile.layers.waterway, (p) => p.brunnel != "tunnel" && waterway_styles[p.class] && z >= waterway_styles[p.class].min_z ? p.class : null))
            stroke(group, "#7cc8ff", style_width(waterway_styles[cls], z, .6));

        // borders, maritime borders are left out
        const boundaries = collect(tile.layers.boundary, (p) => {
            if (p.maritime == 1)
                return null;
            const i = boundary_styles.findIndex(b => (p.admin_level || 99) <= b.max_level);
            return i >= 0 && z >= boundary_styles[i].min_z ? i : null;
        });
        for (const i of [...boundaries.keys()].sort((a, b) => b - a)) {
            // zoomed out (below 14) the country and state borders shrink slowly down to min_w, they stay visible
            const b = boundary_styles[i], w = z < 14 && b.shrink ? style_width(b, z) : b.w * zf ** b.grow;
            stroke(boundaries.get(i), b.casing, w + 1.5);
            stroke(boundaries.get(i), b.col, w, b.dash.map(d => d * w));
        }

        // ridges, aretes and cliffs (lines of the mountain peak layer)
        const ridges = collect(tile.layers.mountain_peak, (p) => z >= 12 && ["ridge", "arete", "cliff"].includes(p.class) ? (p.class == "cliff" ? "cliff" : "ridge") : null);
        const ridge_w = Math.max(1.2 * zf ** .5, .8);
        if (ridges.has("ridge")) {
            stroke(ridges.get("ridge"), "rgba(60, 30, 0, .6)", ridge_w + 1.4);
            stroke(ridges.get("ridge"), "#ffb36b", ridge_w);
        }
        if (ridges.has("cliff")) {
            stroke(ridges.get("cliff"), "rgba(255, 255, 255, .5)", ridge_w + 1.4);
            stroke(ridges.get("cliff"), "#4a3424", ridge_w, [2 * ridge_w, ridge_w]);
        }

        // roads, tunnels are drawn faint, all casings are drawn before the fills so crossings are not interrupted
        const roads = collect(tile.layers.transportation, (p) => {
            const name = road_style_name(p);
            if (!name || z < road_styles[name].min_z)
                return null;
            return (p.brunnel == "tunnel" ? "tunnel:" : "") + name;
        });
        // dashed lines (paths, tracks, rails) are narrow in reality, they grow slower with the zoom than the roads
        const road_w = (st) => st.dash ? Math.max(st.w * zf ** .5, .7) : style_width(st, z, .5);
        const road_dash = (st) => st.dash && st.dash.map(d => d * Math.max(road_w(st) / st.w, 1));
        for (const name of road_order)
            if (roads.has("tunnel:" + name))
                stroke(roads.get("tunnel:" + name), road_styles[name].col, road_w(road_styles[name]), road_dash(road_styles[name]), .45);
        for (const name of road_order)
            if (roads.has(name) && !road_styles[name].no_casing)
                stroke(roads.get(name), casing_col, road_w(road_styles[name]) + 1.2 * Math.min(Math.max(zf, 1), 2));
        for (const name of road_order)
            if (roads.has(name))
                stroke(roads.get(name), road_styles[name].col, road_w(road_styles[name]), road_dash(road_styles[name]));

        // labels, the layout is done for the whole source tile so that overzoomed neighbor tiles agree on it
        let labels = [], atlas = null;
        if (with_labels) {
            const mctx = new OffscreenCanvas(1, 1).getContext("2d");
            const shown = get_label_layout(tile, z, tile_size * sub, mctx).filter(({box: [x0, y0, x1, y1]}) =>
                x0 - ox <= tile_size && x1 - ox >= 0 && y0 - oy <= tile_size && y1 - oy >= 0);
            const packed = pack_labels(shown, 1024);
            atlas = packed.atlas;
            labels = packed.labels.map(l => ({x: l.x - ox, y: l.y - oy, angle: l.angle || 0, w: l.w, h: l.h, ax: l.ax, ay: l.ay,
                                              atlas_x: l.atlas_x, atlas_y: l.atlas_y}));
        }
        return {pieces: new Float32Array(pieces), groups, strokes, labels, atlas};
    };

    // ---------------------------------------------------------------------------------------------------------
    // 3d: line segments and label atlas of a tile (z <= max zoom of the data) for the VectorRenderer
    // ---------------------------------------------------------------------------------------------------------
    const style_index = new Map(line_style_keys.map((k, i) => [k, i]));
    const max_piece = 1 / 64;   // lines are subdivided into pieces of at most this tile fraction to follow the terrain
    /**
     * @returns {Float32Array} per piece [ax, ay, bx, by (tile fraction), along a, along b (meters from the line start), style, flags (1: tunnel)]
     */
    const build_segments = (tile, z, y) => {
        // meters per tile at the latitude of the tile center
        const lat = Math.atan(Math.sinh(Math.PI * (1 - 2 * (y + .5) / 2 ** z)));
        const tile_m = 40075016.686 * Math.cos(lat) / 2 ** z;
        const by_style = line_style_keys.map(() => []);
        const add = (layer, f, key, flags) => {
            const st = style_index.get(key);
            if (st === undefined)
                return;
            const out = by_style[st];
            const s = 1 / layer.extent;
            for (const part of f.parts) {
                let along = 0;
                for (let i = 2; i < part.length; i += 2) {
                    const ax = part[i - 2] * s, ay = part[i - 1] * s, bx = part[i] * s, by = part[i + 1] * s;
                    const len = Math.hypot(bx - ax, by - ay);
                    // pieces in the buffer of the tile are drawn by the neighbor tile
                    if (Math.max(ax, bx) >= 0 && Math.min(ax, bx) <= 1 && Math.max(ay, by) >= 0 && Math.min(ay, by) <= 1) {
                        const n = Math.max(1, Math.ceil(len / max_piece));
                        for (let k = 0; k < n; ++k)
                            out.push(ax + (bx - ax) * k / n, ay + (by - ay) * k / n, ax + (bx - ax) * (k + 1) / n, ay + (by - ay) * (k + 1) / n,
                                     along + len * tile_m * k / n, along + len * tile_m * (k + 1) / n, st, flags);
                    }
                    along += len * tile_m;
                }
            }
        };
        const lines = (name) => tile.layers[name] ? tile.layers[name].features.filter(f => f.type == 2) : [];
        for (const f of lines("waterway"))
            if (f.props.brunnel != "tunnel" && waterway_styles[f.props.class])
                add(tile.layers.waterway, f, "water_" + f.props.class, 0);
        for (const f of lines("boundary")) {
            if (f.props.maritime == 1)
                continue;
            const i = boundary_styles.findIndex(b => (f.props.admin_level || 99) <= b.max_level);
            if (i >= 0 && z >= boundary_styles[i].min_z)
                add(tile.layers.boundary, f, "boundary_" + i, 0);
        }
        for (const f of lines("mountain_peak"))
            if (["ridge", "arete", "cliff"].includes(f.props.class))
                add(tile.layers.mountain_peak, f, f.props.class == "cliff" ? "cliff" : "ridge", 0);
        for (const f of lines("transportation")) {
            const name = road_style_name(f.props);
            if (name && z >= road_styles[name].min_z)
                add(tile.layers.transportation, f, name, f.props.brunnel == "tunnel" ? 1 : 0);
        }
        return new Float32Array(by_style.flat());
    };

    /**
     * @brief labels of a tile as billboards. Only labels with their anchor inside the tile are kept (the neighbors have the
     * others), their images are packed into one atlas
     * @returns {{labels: Array, atlas: ImageBitmap}} labels with x, y (tile fraction), the atlas rect (atlas_x, atlas_y, w, h),
     * the anchor in the rect (ax, ay), prio (lower is more important) and for street names the half segment hx, hy (tile fraction)
     */
    const build_labels = (tile, z, with_housenames) => {
        const labels = [];
        // the image rects are made by pack_labels
        const add = (label, layer, px, py) => {
            if (px < 0 || py < 0 || px >= layer.extent || py >= layer.extent)
                return;
            labels.push({...label, x: px / layer.extent, y: py / layer.extent});
        };
        const place_prio = {city: 0, town: 10, village: 30, suburb: 40, hamlet: 50, quarter: 60, locality: 60, neighbourhood: 70, isolated_dwelling: 80};
        if (tile.layers.place)
            for (const f of tile.layers.place.features) {
                const st = place_styles[f.props.class];
                if (f.type == 1 && st && z >= Math.min(st.min_z, 14) && name_of(f.props))
                    add({text: name_of(f.props), font: st.font, col: "#ffffff", tx: 0, ty: 0, prio: place_prio[f.props.class] + (f.props.rank || 0) * .1},
                        tile.layers.place, f.parts[0][0], f.parts[0][1]);
            }
        if (tile.layers.mountain_peak)
            for (const f of tile.layers.mountain_peak.features) {
                const cls = f.props.class;
                if (f.type != 1 || !(cls == "peak" || cls == "volcano" || (cls == "saddle" && z >= 14)))
                    continue;
                const ele = f.props.ele != null ? `${Math.round(f.props.ele)} m` : "";
                add({text: [name_of(f.props), ele].filter(t => t).join(" "), font: "11px sans-serif", col: "#ffe2b8", tx: 0, ty: 11,
                     symbol: cls == "saddle" ? "saddle" : "peak", ele: f.props.ele, prio: 20 + (f.props.rank || 0)},
                    tile.layers.mountain_peak, f.parts[0][0], f.parts[0][1]);
            }
        if (tile.layers.poi && z >= 13)
            for (const f of tile.layers.poi.features) {
                const tier = f.type == 1 && name_of(f.props) ? poi_tier(f.props) : null;
                if (tier)
                    add({text: name_of(f.props), font: "10px sans-serif", col: "#e6f2ff", tx: 0, ty: 10, symbol: "poi",
                         max_dist: poi_max_dist_m[tier], prio: 85 + 5 * tier + (f.props.rank || 0) * .1},
                        tile.layers.poi, f.parts[0][0], f.parts[0][1]);
            }
        if (with_housenames && z == housename_src_z)
            for (const h of housenames_of_tile(tile) || [])
                add({text: h.name, font: "italic 10px sans-serif", tx: 0, ty: 10, ...housename_style(h), max_dist: housename_max_dist_m, prio: 92},
                    {extent: 1}, h.x, h.y);
        const road_names = tile.layers.transportation_name;
        if (road_names && z >= 13)
            for (const f of road_names.features) {
                if (f.type != 2 || !name_of(f.props))
                    continue;
                // at the middle of the longest segment, rotated along it on the screen
                let best = null;
                for (const part of f.parts)
                    for (let i = 2; i < part.length; i += 2) {
                        const l = Math.hypot(part[i] - part[i - 2], part[i + 1] - part[i - 1]);
                        if (!best || l > best.l)
                            best = {l, x: (part[i] + part[i - 2]) / 2, y: (part[i + 1] + part[i - 1]) / 2,
                                    hx: (part[i] - part[i - 2]) / 2 / road_names.extent, hy: (part[i + 1] - part[i - 1]) / 2 / road_names.extent};
                    }
                const rank = road_order.indexOf(road_style_name(f.props) || "");
                if (best)
                    add({text: name_of(f.props), font: "11px sans-serif", col: "#ffffff", tx: 0, ty: 0, hx: best.hx, hy: best.hy, prio: 100 + road_order.length - rank},
                        road_names, best.x, best.y);
            }
        labels.sort((a, b) => a.prio - b.prio);
        // at most 1 MB per tile, the least important labels are left out
        const {labels: packed, atlas} = pack_labels(labels, 512);
        return {labels: packed.map(l => ({x: l.x, y: l.y, w: l.w, h: l.h, ax: l.ax, ay: l.ay, atlas_x: l.atlas_x, atlas_y: l.atlas_y,
                                          prio: l.prio, ele: l.ele, hx: l.hx, hy: l.hy, max_dist: l.max_dist})),
                atlas};
    };

    /**
     * @brief places the labels of a source tile for zoom z in pixel coordinates of the whole (scaled) source tile.
     * size is the edge length of the scaled source tile in pixels. A label may only reach over the border of the source
     * tile if its anchor lies in the buffer of the neighbor tile, the neighbor then places it at the same position and
     * draws the other part. Later labels are dropped if they overlap earlier ones (priority order)
     */
    const get_label_layout = (tile, z, size, ctx) => {
        if (tile.label_layouts.has(z))
            return tile.label_layouts.get(z);
        const labels = [];
        const boxes = [];
        // buffer: distance in pixels the features of the layer reach into the neighbor tiles, 0 for labels that must not cross
        const try_place = (label, w, h, buffer) => {
            // box of the (rotated) text in source tile pixels
            const c = Math.abs(Math.cos(label.angle || 0)), s = Math.abs(Math.sin(label.angle || 0));
            const hw = (w * c + h * s) / 2 + 2, hh = (w * s + h * c) / 2 + 2;
            const cx = label.x + label.tx, cy = label.y + label.ty;
            const box = [Math.min(cx - hw, label.x - 6), Math.min(cy - hh, label.y - 6), Math.max(cx + hw, label.x + 6), Math.max(cy + hh, label.y + 6)];
            if ((box[0] < 0 && label.x > buffer) || (box[2] > size && label.x < size - buffer) ||
                (box[1] < 0 && label.y > buffer) || (box[3] > size && label.y < size - buffer))
                return;
            if (boxes.some(b => b[0] < box[2] && b[2] > box[0] && b[1] < box[3] && b[3] > box[1]))
                return;
            boxes.push(box);
            label.box = box;
            labels.push(label);
        };
        const measure = (text, font) => {
            ctx.font = font;
            return ctx.measureText(text).width;
        };

        const places = tile.layers.place;
        if (places) {
            const s = size / places.extent;
            const feats = places.features.filter(f => f.type == 1 && place_styles[f.props.class] && z >= place_styles[f.props.class].min_z && name_of(f.props))
                                         .sort((a, b) => (a.props.rank || 99) - (b.props.rank || 99));
            for (const f of feats) {
                const st = place_styles[f.props.class];
                const text = name_of(f.props);
                try_place({x: f.parts[0][0] * s, y: f.parts[0][1] * s, tx: 0, ty: 0, text, font: st.font, col: "#ffffff"}, measure(text, st.font), parseInt(/(\d+)px/.exec(st.font)[1]), places.buffer * s);
            }
        }
        const peaks = tile.layers.mountain_peak;
        if (peaks) {
            const s = size / peaks.extent;
            const font = "11px sans-serif";
            const feats = peaks.features.filter(f => f.type == 1 && (f.props.class == "peak" || f.props.class == "volcano" || (f.props.class == "saddle" && z >= 14)))
                                        .sort((a, b) => (a.props.rank || 99) - (b.props.rank || 99));
            for (const f of feats) {
                const ele = f.props.ele != null ? `${Math.round(f.props.ele)} m` : "";
                const text = [name_of(f.props), ele].filter(t => t).join(" ");
                try_place({x: f.parts[0][0] * s, y: f.parts[0][1] * s, tx: 0, ty: 11, text, font, col: "#ffe2b8", symbol: f.props.class == "saddle" ? "saddle" : "peak"},
                          measure(text, font), 11, peaks.buffer * s);
            }
        }
        const pois = tile.layers.poi;
        if (pois && z >= poi_min_z[1]) {
            const s = size / pois.extent;
            const font = "10px sans-serif";
            const feats = pois.features.filter(f => f.type == 1 && name_of(f.props) && poi_tier(f.props) && z >= poi_min_z[poi_tier(f.props)])
                                       .sort((a, b) => poi_tier(a.props) - poi_tier(b.props) || (a.props.rank || 99) - (b.props.rank || 99));
            for (const f of feats) {
                const text = name_of(f.props);
                try_place({x: f.parts[0][0] * s, y: f.parts[0][1] * s, tx: 0, ty: 10, text, font, col: "#e6f2ff", symbol: "poi"},
                          measure(text, font), 10, pois.buffer * s);
            }
        }
        const road_names = tile.layers.transportation_name;
        if (road_names && z >= 13) {
            const s = size / road_names.extent;
            const font = z >= 17 ? "12px sans-serif" : "10px sans-serif";
            const rank = (p) => { const i = road_order.indexOf(road_style_name(p) || ""); return i < 0 ? -1 : i; };
            const feats = road_names.features.filter(f => f.type == 2 && name_of(f.props) && (z >= 15 || rank(f.props) >= road_order.indexOf("tertiary")))
                                             .sort((a, b) => rank(b.props) - rank(a.props));
            for (const f of feats) {
                // horizontal text at the middle of the longest segment, only if it fits on the segment
                let best = null;
                for (const part of f.parts)
                    for (let i = 2; i < part.length; i += 2) {
                        const dx = (part[i] - part[i - 2]) * s, dy = (part[i + 1] - part[i - 1]) * s;
                        const l = Math.hypot(dx, dy);
                        if (!best || l > best.l)
                            best = {l, x: (part[i] + part[i - 2]) * s / 2, y: (part[i + 1] + part[i - 1]) * s / 2, dx, dy};
                    }
                const text = name_of(f.props);
                const w = measure(text, font);
                if (!best || best.l < w + 8)
                    continue;
                let angle = Math.atan2(best.dy, best.dx);
                if (angle > Math.PI / 2) angle -= Math.PI;
                if (angle < -Math.PI / 2) angle += Math.PI;
                try_place({x: best.x, y: best.y, tx: 0, ty: 0, angle, text, font, col: "#ffffff"}, w, parseInt(/(\d+)px/.exec(font)[1]), 0);
            }
        }
        // names of buildings (e.g. farms), the layout is not kept while they are still loading so they are added later
        let complete = true;
        if (z >= housename_min_z && tile.z == housename_src_z) {
            const names = housenames_of_tile(tile);
            if (names) {
                const font = "italic 10px sans-serif";
                for (const h of names)
                    try_place({x: h.x * size, y: h.y * size, tx: 0, ty: 10, text: h.name, font, ...housename_style(h)},
                              measure(h.name, font), 10, housename_margin * size);
            } else
                complete = false;
        }
        if (complete)
            tile.label_layouts.set(z, labels);
        return labels;
    };

    self.onmessage = async (e) => {
        const {id, kind, z, x, y} = e.data;
        try {
            if (kind == "mesh") {
                const tile = await get_tile(z, x, y);
                const segments = build_segments(tile, z, y);
                const {labels, atlas} = build_labels(tile, z, e.data.housenames);
                self.postMessage({id, segments, labels, atlas}, atlas ? [segments.buffer, atlas] : [segments.buffer]);
                return;
            }
            if (kind == "labels") {
                const {labels, atlas} = build_labels(await get_tile(z, x, y), z, e.data.housenames);
                self.postMessage({id, labels, atlas}, atlas ? [atlas] : []);
                return;
            }
            const drawing = await build_tile_drawing(z, x, y, e.data.labels);
            self.postMessage({id, ...drawing}, drawing.atlas ? [drawing.pieces.buffer, drawing.atlas] : [drawing.pieces.buffer]);
        } catch (err) {
            self.postMessage({id, error: String(err)});
        }
    };
};

/**
 * @brief line styles of the 3d lines, the index is the draw priority (higher wins at crossings). Widths are in pixels at
 * 400 m distance, casing is the border width per side in pixels, dash the on and off length in pixels. The casings are
 * opaque, the round caps of neighbor pieces overlap and would be darker
 */
const vector_line_styles_3d = [
    {key: "water_ditch",  col: [.49, .78, 1, 1],    casing: [.1, .3, .5, 1], w: 1,   casing_w: .8},
    {key: "water_drain",  col: [.49, .78, 1, 1],    casing: [.1, .3, .5, 1], w: 1,   casing_w: .8},
    {key: "water_stream", col: [.49, .78, 1, 1],    casing: [.1, .3, .5, 1], w: 1.4, casing_w: .8},
    {key: "water_canal",  col: [.49, .78, 1, 1],    casing: [.1, .3, .5, 1], w: 2.2, casing_w: .8},
    {key: "water_river",  col: [.49, .78, 1, 1],    casing: [.1, .3, .5, 1], w: 2.8, casing_w: .8},
    {key: "boundary_3",   col: [.85, .55, 1, 1],    casing: [.15, .1, .2, 1],  w: 1.3, casing_w: 1, dash: [4, 4]},
    {key: "boundary_2",   col: [.85, .55, 1, 1],    casing: [.15, .1, .2, 1],  w: 1.6, casing_w: 1, dash: [6, 4]},
    {key: "boundary_1",   col: [.85, .55, 1, 1],    casing: [.15, .1, .2, 1],  w: 2.2, casing_w: 1, dash: [8, 4], min_scale: .55},
    {key: "boundary_0",   col: [.38, .05, .5, 1],   casing: [.92, .85, .97, 1], w: 4.5, casing_w: 1.2, dash: [12, 5], min_scale: .8},  // country borders darker and thicker, also far away
    {key: "cliff",        col: [.29, .2, .14, 1],   casing: [.85, .8, .75, 1], w: 2,   casing_w: 1, dash: [4, 2]},
    {key: "ridge",        col: [1, .7, .42, 1],     casing: [.3, .17, .05, 1], w: 2,  casing_w: 1},
    {key: "ferry",        col: [.5, .77, 1, 1],     casing: [0, 0, 0, 0],     w: 1.6, casing_w: 0, dash: [6, 5]},
    {key: "rail",         col: [.87, .87, .87, 1],  casing: [.12, .12, .12, 1], w: 2, casing_w: 1, dash: [8, 4]},
    {key: "path",         col: [1, .42, .3, 1],     casing: [.12, .12, .12, 1], w: 1.8, casing_w: 1, dash: [5, 3]},
    {key: "cycleway",     col: [.35, .66, 1, 1],    casing: [.12, .12, .12, 1], w: 1.8, casing_w: 1, dash: [5, 3]},
    {key: "track",        col: [.91, .76, .48, 1],  casing: [.12, .12, .12, 1], w: 2, casing_w: 1, dash: [6, 3]},
    {key: "service",      col: [.93, .93, .93, 1],  casing: [.12, .12, .12, 1], w: 1.8, casing_w: 1},
    {key: "minor",        col: [1, 1, 1, 1],        casing: [.12, .12, .12, 1], w: 2.6, casing_w: 1},
    {key: "tertiary",     col: [1, 1, 1, 1],        casing: [.12, .12, .12, 1], w: 3.2, casing_w: 1.2},
    {key: "secondary",    col: [1, .94, .6, 1],     casing: [.12, .12, .12, 1], w: 3.6, casing_w: 1.2},
    {key: "primary",      col: [.99, .82, .47, 1],  casing: [.12, .12, .12, 1], w: 4,   casing_w: 1.2},
    {key: "trunk",        col: [.97, .71, .41, 1],  casing: [.12, .12, .12, 1], w: 4.6, casing_w: 1.2},
    {key: "motorway",     col: [.95, .61, .36, 1],  casing: [.12, .12, .12, 1], w: 5,   casing_w: 1.2},
];

/**
 * @brief main thread side, sends the requests to the workers. At most max_in_flight requests are worked on at once,
 * the others wait in a queue of at most max_queued requests. Each request has a priority function which is evaluated
 * when a slot gets free, so the order follows the camera: needed (visible) tiles before preloaded ones, which may
 * only use max_in_flight - 1 slots. If the queue is full the request with the lowest priority is dropped (rejected
 * with error.dropped), the requester requests it again if it is needed again
 */
const VectorTileLoader = (() => {
    // the tiles are drawn by several workers in parallel (fewer on phones, they have less memory and cores)
    const coarse_pointer = typeof matchMedia == "function" && matchMedia("(pointer: coarse)").matches;
    const worker_count = Math.max(1, Math.min(coarse_pointer ? 2 : 4, Math.floor((navigator.hardwareConcurrency || 2) / 2)));
    const max_in_flight_per_worker = 2;
    const max_in_flight = worker_count * max_in_flight_per_worker;
    // the decoded source tiles are split over the workers (see affinity), together they keep about as many as one worker did
    const worker_cached_tiles = Math.max(8, Math.ceil(32 / worker_count));
    const workers = Array.from({length: worker_count}, () => ({worker: null, in_flight: 0}));
    let next_id = 0;
    let in_flight = 0;
    const pending = new Map();  // id -> {req, w} with the index w of the worker
    const max_queued = 64;
    const needed_priority = 2e6;   // priorities from here on are needed tiles, below are preloaded ones
    const queue = [];
    const housename_listeners = [];
    /** @brief the requests of a crashed worker fail, it is created again by the next request */
    const fail_worker = (w, err) => {
        for (const [id, p] of pending)
            if (p.w == w) {
                p.req.reject(err);
                pending.delete(id);
                --in_flight;
            }
        workers[w] = {worker: null, in_flight: 0};
    };
    /**
     * @returns {int} the worker for a request: all tiles of a zoom 13 area go to the same worker, so the overzoomed
     * tiles of a source tile share its decoded data and the building names of an area are only loaded once
     */
    const worker_of = (msg) => {
        const d = Math.max(msg.z - 13, 0);
        const key = `${msg.z - d}/${msg.x >> d}/${msg.y >> d}`;
        let h = 0;
        for (let i = 0; i < key.length; ++i)
            h = (h * 31 + key.charCodeAt(i)) | 0;
        return Math.abs(h) % worker_count;
    };
    const get_worker = (w) => {
        if (!workers[w].worker) {
            const src = `const line_style_keys = ${JSON.stringify(vector_line_styles_3d.map(st => st.key))};\n` +
                        `const worker_cached_tiles = ${worker_cached_tiles};\n(${vector_tile_worker_main.toString()})()`;
            const worker = new Worker(URL.createObjectURL(new Blob([src], {type: "text/javascript"})));
            worker.onmessage = (e) => {
                if (e.data.event == "housenames") {
                    for (const f of housename_listeners)
                        f(e.data);
                    return;
                }
                const p = pending.get(e.data.id);
                if (p) {
                    pending.delete(e.data.id);
                    --in_flight;
                    --workers[p.w].in_flight;
                    if (e.data.error) p.req.reject(new Error(e.data.error));
                    else p.req.resolve(e.data);
                }
                pump();
            };
            worker.onerror = (e) => { console.error("vector tile worker failed", e.message); fail_worker(w, new Error(e.message)); };
            workers[w].worker = worker;
        }
        return workers[w].worker;
    };
    /** @returns {int} index of the request with the highest priority, -1 for an empty queue. Requests not needed anymore are removed */
    const best_request = () => {
        let best = -1, best_priority = -Infinity;
        for (let i = queue.length - 1; i >= 0; --i) {
            if (!queue[i].still_needed()) {
                queue.splice(i, 1);
                if (best > i)
                    --best;
                continue;
            }
            queue[i].current_priority = queue[i].priority();
            if (queue[i].current_priority > best_priority) {
                best = i;
                best_priority = queue[i].current_priority;
            }
        }
        return best;
    };
    const pump = () => {
        if (in_flight >= max_in_flight || best_request() < 0)
            return;
        // in priority order, a request whose worker is busy waits and the next one with a free worker is taken
        const order = queue.map((req, i) => i).sort((a, b) => queue[b].current_priority - queue[a].current_priority);
        const taken = [];
        for (const i of order) {
            if (in_flight >= max_in_flight)
                break;
            const req = queue[i];
            // one slot is kept free for needed tiles
            if (req.current_priority < needed_priority && in_flight >= max_in_flight - 1)
                break;
            const w = worker_of(req.msg);
            if (workers[w].in_flight >= max_in_flight_per_worker)
                continue;
            const id = next_id++;
            pending.set(id, {req, w});
            ++in_flight;
            ++workers[w].in_flight;
            get_worker(w).postMessage({id, ...req.msg});
            taken.push(i);
        }
        for (const i of taken.sort((a, b) => b - a))
            queue.splice(i, 1);
    };
    /**
     * @param {function():bool} still_needed false drops the request
     * @param {function():float} priority higher is more important, >= needed_priority for needed tiles
     * @returns {Promise}
     */
    const request = (msg, still_needed, priority) => {
        const req = {msg, still_needed, priority: priority || (() => needed_priority)};
        const promise = new Promise((resolve, reject) => {
            req.resolve = resolve;
            req.reject = reject;
        });
        queue.push(req);
        pump();
        if (queue.length > max_queued) {
            // the least important request is dropped, this can be the new one
            best_request();
            let worst = 0;
            for (let i = 1; i < queue.length; ++i)
                if (queue[i].current_priority < queue[worst].current_priority)
                    worst = i;
            const [dropped] = queue.splice(worst, 1);
            dropped.reject(Object.assign(new Error("dropped from the full queue"), {dropped: true}));
        }
        return promise;
    };
    return {
        prefix: "vector:",
        /**
         * @param {string} url "vector:z/x/y", "vector:z/x/y?nolabels" leaves the labels out
         * @param {function():bool} still_needed False if the tile was reset or reused in the meantime
         * @param {function():float} priority see request
         * @returns {Promise<Object>} a tile drawn by the gpu into the texture of the virtual map (see VectorTileGpu.tile)
         */
        load: function (url, still_needed, priority) {
            const m = /^vector:(\d+)\/(\d+)\/(\d+)(\?nolabels)?$/.exec(url);
            if (!m)
                return Promise.reject(new Error(`invalid vector tile url ${url}`));
            return request({kind: "texture", z: +m[1], x: +m[2], y: +m[3], labels: !m[4]}, still_needed, priority).then(d => VectorTileGpu.tile(d));
        },
        /**
         * @brief line pieces and labels for the VectorRenderer
         * @returns {Promise<{segments: Float32Array, labels: Array, atlas: ImageBitmap}>}
         */
        load_mesh: function (z, x, y, still_needed, priority, housenames) {
            return request({kind: "mesh", z, x, y, housenames}, still_needed, priority);
        },
        /** @returns {Promise<{labels: Array, atlas: ImageBitmap}>} only the labels of a tile, e.g. after the building names arrived */
        load_labels: function (z, x, y, still_needed, priority, housenames) {
            return request({kind: "labels", z, x, y, housenames}, still_needed, priority);
        },
        needed_priority: needed_priority,
        /** @returns {int} requests which can be queued before the least important ones are dropped */
        free_queue_slots: function () {
            return max_queued - queue.length;
        },
        /** @brief f({z, x, y}) is called when the building names of that tile area were loaded, tiles of the area have to be drawn again */
        add_housename_listener: function (f) {
            housename_listeners.push(f);
        },
    };
})();

tile_source_loaders.push(VectorTileLoader);

/**
 * @brief draws the vector tiles of the overlay with the gpu directly into their layer of the texture array of the
 * virtual map (premultiplied alpha). The worker sends the line pieces and the strokes in drawing order (as the strokes of
 * canvas paths: round caps and joins, dashes) and the labels as sprites of an atlas.
 * Each stroke first collects the coverage of its pieces with a max blend in a helper texture and then blends its color
 * once with that coverage: overlapping pieces (joints, crossings of the same style) would be blended several times otherwise
 */
const VectorTileGpu = (() => {
    let gl = null;
    let programs = null;
    let target_fb = null, coverage_fb = null, coverage_tex = null, coverage_size = 0;
    let piece_vao = null, label_vao = null;
    const init = (g) => {
        gl = g;
        const line_vs = `#version 300 es
        precision highp float;
        layout(location = 0) in vec4 seg;       // a, b in tile pixels
        layout(location = 1) in vec2 along_ab;  // length along the line at a and b in pixels
        uniform float hw;                       // half width in pixels
        uniform float tile_size;
        out vec2 local;                         // along and across the piece in pixels, from a
        out float along;
        flat out float len;
        void main() {
            int c = gl_VertexID;
            bool at_b = c >= 2;
            float side = (c & 1) == 1 ? 1. : -1.;
            vec2 d = seg.zw - seg.xy;
            len = length(d);
            vec2 dir = len > 1e-6 ? d / len : vec2(1, 0);
            float e = hw + 1.;  // the quad reaches over the ends for the round caps, 1 pixel for the antialiasing
            vec2 p = (at_b ? seg.zw : seg.xy) + dir * (at_b ? e : -e) + vec2(-dir.y, dir.x) * side * e;
            local = vec2(at_b ? len + e : -e, side * e);
            along = along_ab.x + local.x;
            gl_Position = vec4(p / tile_size * 2. - 1., 0, 1);
        }`;
        const line_fs = `#version 300 es
        precision highp float;
        in vec2 local;
        in float along;
        flat in float len;
        uniform float hw;
        uniform vec2 dash;                      // on, off in pixels, 0 for solid lines
        out vec4 out_col;
        void main() {
            float r = local.x < 0. ? length(local) : local.x > len ? length(vec2(local.x - len, local.y)) : abs(local.y);
            if (dash.x > 0.) {
                // as the canvas: each dash has round caps, distance along the line to the closest dash combined with r
                float m = mod(along, dash.x + dash.y);
                float outside = m <= dash.x ? 0. : min(m - dash.x, dash.x + dash.y - m);
                r = length(vec2(outside, r));
            }
            out_col = vec4(clamp(hw - r + .5, 0., 1.));
        }`;
        const fullscreen_vs = `#version 300 es
        void main() {
            gl_Position = vec4(gl_VertexID == 1 ? 3. : -1., gl_VertexID == 2 ? 3. : -1., 0, 1);
        }`;
        const composite_fs = `#version 300 es
        precision highp float;
        uniform sampler2D coverage;
        uniform vec4 color;
        out vec4 out_col;
        void main() {
            float cov = texelFetch(coverage, ivec2(gl_FragCoord.xy), 0).r;
            out_col = vec4(color.rgb * color.a, color.a) * cov;  // premultiplied
        }`;
        const label_vs = `#version 300 es
        precision highp float;
        layout(location = 0) in vec4 anchor;    // x, y in tile pixels, angle
        layout(location = 1) in vec4 rect;      // atlas x, y, w, h
        layout(location = 2) in vec2 anchor_px; // anchor in the rect
        uniform float tile_size;
        uniform vec2 atlas_size;
        out vec2 uv;
        void main() {
            vec2 corner = vec2(gl_VertexID & 1, gl_VertexID >> 1);
            vec2 off = corner * rect.zw - anchor_px;
            float s = sin(anchor.z), c = cos(anchor.z);
            vec2 p = anchor.xy + vec2(c * off.x - s * off.y, s * off.x + c * off.y);
            gl_Position = vec4(p / tile_size * 2. - 1., 0, 1);
            uv = (rect.xy + corner * rect.zw) / atlas_size;
        }`;
        const label_fs = `#version 300 es
        precision highp float;
        in vec2 uv;
        uniform sampler2D atlas;
        out vec4 out_col;
        void main() {
            out_col = texture(atlas, uv);   // premultiplied
        }`;
        const program = (vs, fs, names) => {
            const p = initShaderProgram(gl, vs, fs);
            const u = {program: p};
            for (const name of names)
                u[name] = gl.getUniformLocation(p, name);
            return u;
        };
        programs = {
            line: program(line_vs, line_fs, ["hw", "tile_size", "dash"]),
            composite: program(fullscreen_vs, composite_fs, ["coverage", "color"]),
            label: program(label_vs, label_fs, ["tile_size", "atlas_size", "atlas"]),
        };
        target_fb = gl.createFramebuffer();
        coverage_fb = gl.createFramebuffer();
        piece_vao = gl.createVertexArray();
        gl.bindVertexArray(piece_vao);
        for (const a of [0, 1]) {
            gl.enableVertexAttribArray(a);
            gl.vertexAttribDivisor(a, 1);
        }
        label_vao = gl.createVertexArray();
        gl.bindVertexArray(label_vao);
        for (const a of [0, 1, 2]) {
            gl.enableVertexAttribArray(a);
            gl.vertexAttribDivisor(a, 1);
        }
        gl.bindVertexArray(null);
    };
    const ensure_coverage = (size) => {
        if (coverage_size == size)
            return;
        if (coverage_tex)
            gl.deleteTexture(coverage_tex);
        coverage_tex = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, coverage_tex);
        gl.texStorage2D(gl.TEXTURE_2D, 1, gl.R8, size, size);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
        gl.bindFramebuffer(gl.FRAMEBUFFER, coverage_fb);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, coverage_tex, 0);
        coverage_size = size;
    };
    /**
     * @brief draws the tile into a layer of a texture array, over its content (clear: true clears it first)
     */
    const draw = (g, d, texture, layer, size, clear) => {
        if (gl !== g)
            init(g);
        ensure_coverage(size);
        const viewport = gl.getParameter(gl.VIEWPORT);
        const depth_test = gl.isEnabled(gl.DEPTH_TEST), cull_face = gl.isEnabled(gl.CULL_FACE);
        gl.disable(gl.DEPTH_TEST);
        gl.disable(gl.CULL_FACE);
        gl.viewport(0, 0, size, size);
        gl.bindFramebuffer(gl.FRAMEBUFFER, target_fb);
        gl.framebufferTextureLayer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, texture, 0, layer);
        gl.drawBuffers([gl.COLOR_ATTACHMENT0]);
        if (clear) {
            gl.clearColor(0, 0, 0, 0);
            gl.clear(gl.COLOR_BUFFER_BIT);
        }
        gl.enable(gl.BLEND);
        if (d.strokes.length) {
            const buffer = gl.createBuffer();
            gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
            gl.bufferData(gl.ARRAY_BUFFER, d.pieces, gl.STREAM_DRAW);
            gl.bindVertexArray(piece_vao);
            gl.activeTexture(gl.TEXTURE0);
            for (const st of d.strokes) {
                const group = d.groups[st.group];
                // coverage of the stroke, max of the overlapping pieces
                gl.bindFramebuffer(gl.FRAMEBUFFER, coverage_fb);
                gl.drawBuffers([gl.COLOR_ATTACHMENT0]);
                gl.clearColor(0, 0, 0, 0);
                gl.clear(gl.COLOR_BUFFER_BIT);
                gl.blendEquation(gl.MAX);
                gl.useProgram(programs.line.program);
                gl.uniform1f(programs.line.hw, st.width / 2);
                gl.uniform1f(programs.line.tile_size, size);
                gl.uniform2f(programs.line.dash, st.dash[0], st.dash[1]);
                // no base instance in webgl2, the attribute pointers start at the first piece of the group
                gl.vertexAttribPointer(0, 4, gl.FLOAT, false, 24, group.first * 24);
                gl.vertexAttribPointer(1, 2, gl.FLOAT, false, 24, group.first * 24 + 16);
                gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, group.count);
                // its color blended once with the coverage
                gl.bindTexture(gl.TEXTURE_2D, null);
                gl.bindFramebuffer(gl.FRAMEBUFFER, target_fb);
                gl.blendEquation(gl.FUNC_ADD);
                gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
                gl.useProgram(programs.composite.program);
                gl.bindTexture(gl.TEXTURE_2D, coverage_tex);
                gl.uniform1i(programs.composite.coverage, 0);
                gl.uniform4fv(programs.composite.color, st.color);
                gl.drawArrays(gl.TRIANGLES, 0, 3);
                gl.bindTexture(gl.TEXTURE_2D, null);
            }
            gl.deleteBuffer(buffer);
        }
        if (d.labels.length && d.atlas) {
            const atlas = gl.createTexture();
            gl.activeTexture(gl.TEXTURE0);
            gl.bindTexture(gl.TEXTURE_2D, atlas);
            gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
            gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, d.atlas);
            gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
            const data = new Float32Array(d.labels.length * 10);
            d.labels.forEach((l, i) => {
                // unrotated labels at whole pixels, sharp text
                const x = l.angle ? l.x : Math.round(l.x), y = l.angle ? l.y : Math.round(l.y);
                data.set([x, y, l.angle, 0, l.atlas_x, l.atlas_y, l.w, l.h, l.ax, l.ay], i * 10);
            });
            const buffer = gl.createBuffer();
            gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
            gl.bufferData(gl.ARRAY_BUFFER, data, gl.STREAM_DRAW);
            gl.bindVertexArray(label_vao);
            gl.vertexAttribPointer(0, 4, gl.FLOAT, false, 40, 0);
            gl.vertexAttribPointer(1, 4, gl.FLOAT, false, 40, 16);
            gl.vertexAttribPointer(2, 2, gl.FLOAT, false, 40, 32);
            gl.blendEquation(gl.FUNC_ADD);
            gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
            gl.useProgram(programs.label.program);
            gl.uniform1f(programs.label.tile_size, size);
            gl.uniform2f(programs.label.atlas_size, d.atlas.width, d.atlas.height);
            gl.uniform1i(programs.label.atlas, 0);
            gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, d.labels.length);
            gl.deleteBuffer(buffer);
            gl.bindTexture(gl.TEXTURE_2D, null);
            gl.deleteTexture(atlas);
        }
        gl.bindVertexArray(null);
        gl.bindBuffer(gl.ARRAY_BUFFER, null);
        gl.useProgram(null);
        gl.disable(gl.BLEND);
        gl.blendEquation(gl.FUNC_ADD);
        gl.framebufferTextureLayer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, null, 0, 0);
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        gl.viewport(viewport[0], viewport[1], viewport[2], viewport[3]);
        if (depth_test)
            gl.enable(gl.DEPTH_TEST);
        if (cull_face)
            gl.enable(gl.CULL_FACE);
    };
    return {
        /**
         * @param {Object} d drawing from the worker (build_tile_drawing)
         * @returns {Object} a tile source of the virtual map: gpu_draw(gl, texture, layer, size, clear) draws it into the
         * texture array (premultiplied alpha), close() frees the atlas
         */
        tile: (d) => ({
            gpu: true,
            decoded: true,
            drawing: d,     // the data from the worker, e.g. for a comparison with a canvas rendering
            width: 256,
            height: 256,
            gpu_draw: (g, texture, layer, size, clear) => draw(g, d, texture, layer, size, clear),
            close: () => {
                if (d.atlas)
                    d.atlas.close();
                d.atlas = null;
            },
        }),
    };
})();

/**
 * @brief draws the vector tile lines draped on the terrain (screen space quads like the gpx track) and the labels as
 * billboards with a constant screen size.
 * The tiles are taken from rings around the camera: ring k has the zoom level base - 2k, the finer ring is cut out of
 * the coarser one in the fragment shader. A tile of a ring which is not loaded yet is replaced by its deepest loaded
 * ancestor (clipped to the area of the tile). The tiles are kept in a cache like the virtual textures (recently used and
 * coarse tiles are kept the longest), the tiles around the rings and of the neighbor zoom levels are preloaded
 */
const VectorRenderer = () => {
    const ring_count = 3;
    const retry_ms = 10000;             // tiles which could not be loaded are requested again after this time
    const coarse_level_priority_ms = 1000;  // a tile one level coarser is kept like a tile which was used this much more recently
    const max_labels = 400;
    const label_floats = 12;
    const label_occlusion_m = 30;       // the terrain has to be at least this much (or 4 % of the distance) in front of a label to hide it
    const label_fade_in_ms = 150;       // labels fade in when they are placed
    const label_fade_out_ms = 400;      // and out when they are hidden (occluded, by a neighbor, too far away). An occluded label
                                        // keeps its place while fading and fades in again if it is visible meanwhile (unstable depth)
    const label_lift_m = 10;            // the labels are drawn this far above their anchor on the terrain, with a line down to it
    const street_label_lift_m = 1;      // street names lie close to their street, without a line
    return {
        /** @type {WebGL2RenderingContext} */
        gl: null,
        line_program: null,
        label_program: null,
        line_uniforms: {},
        label_uniforms: {},
        tiles: new Map(),       // "z/x/y" -> {z, x, y, state: "loading"|"ready"|"failed", count, vao, buffer, atlas, atlas_w, atlas_h, labels, last_use, fail_time}
        version: 0,             // incremented when a tile finished loading, the drawn tiles are selected again then
        drawn: null,            // {sig, version, rings: [{exclude, entries: [{tile, rect}]}], labels}
        needed_keys: new Set(), // tiles of the current rings, their completion triggers a redraw
        housename_keys: new Set(), // tiles close to the camera, their labels include the building names
        request_class: new Map(),  // key -> 2: needed (rings and fallback), 1: preloaded, for the priority of the requests
        cam: {x: 0, y: 0},
        label_buffer: null,
        label_vao: null,
        label_data: new Float32Array(max_labels * label_floats),
        on_change: null,        // called when a tile of the rings finished loading

        init: function (gl, virtual_height_map, height_level_offset) {
            this.gl = gl;
            // the labels of the close tiles are rebuilt when the building names of their area arrive
            VectorTileLoader.add_housename_listener(({z, x, y}) => {
                for (const tile of this.tiles.values()) {
                    if (!tile.housenames || tile.z < z || tile.x >> (tile.z - z) != x || tile.y >> (tile.z - z) != y)
                        continue;
                    // a tile still loading might have been built before the names were there, its labels are loaded again when it is ready
                    if (tile.state == "ready")
                        this.refresh_labels(tile);
                    else if (tile.state == "loading")
                        tile.labels_dirty = true;
                }
            });
            this.create_programs(virtual_height_map, height_level_offset);
            this.label_buffer = gl.createBuffer();
            this.label_vao = gl.createVertexArray();
            gl.bindVertexArray(this.label_vao);
            gl.bindBuffer(gl.ARRAY_BUFFER, this.label_buffer);
            gl.bufferData(gl.ARRAY_BUFFER, this.label_data.byteLength, gl.DYNAMIC_DRAW);
            for (let a = 0; a < 3; ++a) {
                gl.enableVertexAttribArray(a);
                gl.vertexAttribDivisor(a, 1);
            }
            gl.bindVertexArray(null);
            gl.bindBuffer(gl.ARRAY_BUFFER, null);
            return this;
        },
        /** @brief (re)creates the shader programs, needed again if a setting compiled into the shaders changes (seamless_tiles) */
        create_programs: function (virtual_height_map, height_level_offset) {
            const gl = this.gl;
            if (this.line_program)
                gl.deleteProgram(this.line_program);
            if (this.label_program)
                gl.deleteProgram(this.label_program);
            const n_styles = vector_line_styles_3d.length;
            // shared by both programs: position on the terrain lifted towards the camera, as for the gpx track
            const common = `#version 300 es
            precision highp int;
            precision highp float;
            precision highp sampler2D;
            precision highp sampler2DArray;
            precision highp usampler2DArray;

            uniform vec2 grid_offset_pos;
            uniform vec3 cam_pos;               // relative to grid_offset_pos
            uniform float eye_offset;           // distance the eye was moved back for the transition to 2d
            uniform mat4 view_proj;
            uniform vec2 viewport;
            uniform float pixel_angle;          // world size of a pixel per distance
            uniform float lod_factor;
            uniform int max_mesh_level;
            uniform float m_per_uv;
            ${Util.glsl_virtual_texture_uniforms("heightmap", virtual_height_map)}
            ${Util.glsl_virtual_heightmap_load()}
            ${Util.glsl_wgs_84_m_to_uv()}

            const vec4 culled = vec4(2., 2., 2., 1.);
            const float min_w = 1e-9;

            vec3 terrain_pos(vec2 p) {
                float dist = max(length(p - cam_pos.xy), 1e-12);
                float mesh_level = clamp(ceil(log2(lod_factor / dist)), 0., float(max_mesh_level));
                float level = max(mesh_level + ${height_level_offset}., 0.);
                return vec3(p, wgs_84_m_to_uv(virtual_heightmap_load(grid_offset_pos, p, level).x) * 1.4);
            }
            // lifted a bit less than the gpx track, which is drawn over the lines
            vec4 lifted_clip_pos(vec3 pos, float extra_px) {
                vec3 to_cam = cam_pos - pos;
                float d = length(to_cam);
                float d_lift = max(d - eye_offset, 0.);
                pos += to_cam / d * min(.5 * d, wgs_84_m_to_uv(1.) + .002 * d_lift + extra_px * pixel_angle * d);
                return view_proj * vec4(pos, 1.);
            }
            `;
            const line_vs = common + `
            layout(location = 0) in vec4 seg;           // a.xy, b.xy as tile fraction
            layout(location = 1) in vec4 seg_info;      // along a, along b in meters, style, flags
            uniform vec2 tile_origin;                   // relative to grid_offset_pos
            uniform float tile_w;
            uniform vec4 style_dims[${n_styles}];       // width, casing width, dash on, dash off in pixels
            uniform float style_min_scale[${n_styles}]; // the width is scaled down with the distance at most to this

            out vec3 local_px;          // along and across the segment in pixels, multiplied by w for screen linear interpolation
            out vec2 ground;
            out float along_m;
            out float m_per_px;
            flat out float len_px;
            flat out float fill_hw;
            flat out float casing_w;
            flat out int style;
            flat out int flags;

            void main() {
                int c = gl_VertexID;    // triangle strip: a left, a right, b left, b right
                bool at_b = c >= 2;
                float side = (c & 1) == 1 ? 1. : -1.;
                style = int(seg_info.z + .5);
                flags = int(seg_info.w + .5);
                vec2 pa = tile_origin + seg.xy * tile_w, pb = tile_origin + seg.zw * tile_w;
                vec3 wa = terrain_pos(pa), wb = terrain_pos(pb);
                vec4 dims = style_dims[style];
                float d_m = max(length(.5 * (wa + wb) - cam_pos) - eye_offset, 0.) * m_per_uv;
                float scale = clamp(sqrt(400. / max(d_m, 1.)), style_min_scale[style], 1.6);
                // far away the casings would cover the fills of the thin lines
                fill_hw = max(.5 * dims.x * scale, .6);
                casing_w = dims.y * min(scale, 1.);
                float hw = fill_hw + casing_w + .5;
                vec4 ca = lifted_clip_pos(wa, hw), cb = lifted_clip_pos(wb, hw);
                if (ca.w < min_w && cb.w < min_w) {
                    gl_Position = culled;
                    return;
                }
                if (ca.w < min_w) ca = mix(ca, cb, (min_w - ca.w) / (cb.w - ca.w));
                if (cb.w < min_w) cb = mix(cb, ca, (min_w - cb.w) / (ca.w - cb.w));
                vec2 d_px = (cb.xy / cb.w - ca.xy / ca.w) * .5 * viewport;
                len_px = length(d_px);
                vec2 dir = len_px > 1e-6 ? d_px / len_px : vec2(1, 0);
                vec2 n = vec2(-dir.y, dir.x);
                vec4 p = at_b ? cb : ca;
                // the quad reaches hw over the ends for the round caps
                float along = at_b ? len_px + hw : -hw;
                vec2 off_px = dir * (at_b ? hw : -hw) + n * side * hw;
                p.xy += off_px * 2. / viewport * p.w;
                gl_Position = p;
                local_px = vec3(along * p.w, side * hw * p.w, p.w);
                ground = at_b ? pb : pa;
                along_m = at_b ? seg_info.y : seg_info.x;
                m_per_px = length((at_b ? wb : wa) - cam_pos) * m_per_uv * pixel_angle;
            }
            `;
            const line_fs = `#version 300 es
            precision highp float;
            precision highp int;
            in vec3 local_px;
            in vec2 ground;
            in float along_m;
            in float m_per_px;
            flat in float len_px;
            flat in float fill_hw;
            flat in float casing_w;
            flat in int style;
            flat in int flags;
            uniform vec4 tile_rect;         // drawn area relative to grid_offset_pos: the tile without its buffer (drawn by the neighbors) or the part of an ancestor replacing a missing tile
            uniform vec4 exclude_rect;      // area of the finer ring
            uniform vec4 style_fill[${n_styles}];
            uniform vec4 style_casing[${n_styles}];
            uniform vec4 style_dims[${n_styles}];
            uniform int fill_pass;          // 0: casings of all lines, 1: fills, so that fills are never covered by the casing of another line
            out vec4 out_col;
            void main() {
                if (any(lessThan(ground, tile_rect.xy)) || any(greaterThanEqual(ground, tile_rect.zw)) ||
                    (all(greaterThanEqual(ground, exclude_rect.xy)) && all(lessThan(ground, exclude_rect.zw))))
                    discard;
                vec2 l = local_px.xy / local_px.z;
                // distance to the segment, round caps at both ends
                float r = l.x < 0. ? length(l) : l.x > len_px ? length(vec2(l.x - len_px, l.y)) : abs(l.y);
                float hw = fill_hw + casing_w;
                if (r > hw + .5)
                    discard;
                vec4 dims = style_dims[style];
                float on = 1.;
                if (dims.z > 0.) {
                    // dash length in pixels, rounded to a power of two in meters so that the pattern does not crawl when moving
                    float period_m = exp2(round(log2(max(m_per_px * (dims.z + dims.w), 1e-3))));
                    on = step(fract(along_m / period_m), dims.z / (dims.z + dims.w));
                }
                vec4 col;
                if (fill_pass == 0) {
                    // tunnels are drawn faint and without casing
                    if (flags == 1)
                        discard;
                    col = style_casing[style];
                    col.a *= clamp(hw + .5 - r, 0., 1.);
                } else {
                    col = style_fill[style];
                    col.a *= clamp(fill_hw + .5 - r, 0., 1.) * on * (flags == 1 ? .45 : 1.);
                }
                if (col.a < .02)
                    discard;
                out_col = col;
            }
            `;
            const label_vs = common + `
            layout(location = 0) in vec4 anchor;        // x, y relative to grid_offset_pos, angle, height above the terrain in meters
            layout(location = 1) in vec4 rect;          // atlas x, y, w, h in pixels
            layout(location = 2) in vec4 anchor_px;     // anchor in the rect x, y, 1 if the visibility is tested here (no depth on the cpu), opacity
            uniform vec2 atlas_size;
            uniform int snap_to_pixels;                 // 1 while the camera does not move
            uniform int leader_lines;                   // 1: the lines from the labels down to their anchor on the terrain, 0: the labels
            out vec2 uv;
            out float alpha;
            // true if the terrain between the camera and the point is above the line of sight, the fallback where the depth of
            // the tile id pass is not known on the cpu (see draw_labels). A depth test of the label itself would cut the parts
            // of the label that are drawn over terrain closer to the camera than the anchor.
            // The terrain is sampled with the level of detail of the drawn terrain, narrow hills need many samples
            bool occluded(vec3 a) {
                const int n = 48;
                // the samples close to the anchor are left out, there the coarser level of the far terrain lies a few
                // meters above the line of sight on slopes and would hide labels that are visible
                const float t_max = .92;
                float tolerance = wgs_84_m_to_uv(5.) * 1.4 + .01 * length(a - cam_pos);
                for (int i = 1; i <= n; ++i) {
                    vec3 q = mix(cam_pos, a, t_max * float(i) / float(n));
                    if (terrain_pos(q.xy).z > q.z + tolerance)
                        return true;
                }
                return false;
            }
            void main() {
                vec2 corner = vec2(gl_VertexID & 1, gl_VertexID >> 1);
                // the anchor height is taken from the finest level, the level of the terrain changes with the distance
                // and the labels would jump up and down while moving
                float h = virtual_heightmap_load(grid_offset_pos, anchor.xy, float(max_mesh_level + ${height_level_offset})).x;
                vec3 a = vec3(anchor.xy, wgs_84_m_to_uv(h + anchor.w) * 1.4);
                vec4 p = lifted_clip_pos(a, 0.);
                if (p.w < min_w || (anchor_px.z > .5 && occluded(a)) || (leader_lines == 1 && anchor.w < ${(label_lift_m / 2).toFixed(1)})) {
                    gl_Position = culled;
                    return;
                }
                if (leader_lines == 1) {
                    // thin quad on the screen from the point on the terrain up to the label
                    vec4 g = lifted_clip_pos(vec3(anchor.xy, wgs_84_m_to_uv(h) * 1.4), 0.);
                    if (g.w < min_w) {
                        gl_Position = culled;
                        return;
                    }
                    vec2 d = (p.xy / p.w - g.xy / g.w) * .5 * viewport;
                    vec2 dir = length(d) > 1e-3 ? normalize(d) : vec2(0, 1);
                    vec4 q = corner.y > .5 ? p : g;
                    q.xy += vec2(-dir.y, dir.x) * (corner.x - .5) * 1.5 * 2. / viewport * q.w;
                    gl_Position = q;
                    uv = vec2(0);
                    alpha = anchor_px.w;
                    return;
                }
                // offset in pixels from the anchor, image y points down. Labels with a line down to the terrain stand on the
                // line (bottom of the image at its top end), the others are placed at their anchor in the image
                bool on_line = anchor.w >= ${(label_lift_m / 2).toFixed(1)};
                vec2 off = (corner * rect.zw - (on_line ? vec2(anchor_px.x, rect.w) : anchor_px.xy)) * vec2(1, -1);
                float s = sin(anchor.z), c = cos(anchor.z);
                off = vec2(c * off.x - s * off.y, s * off.x + c * off.y);
                vec2 ndc = p.xy / p.w;
                if (anchor.z == 0. && snap_to_pixels == 1) {
                    // unrotated labels are aligned to the pixel grid to stay sharp, not while moving: they would move in steps
                    vec2 px = floor((ndc * .5 + .5) * viewport + .5);
                    ndc = (px + off) / viewport * 2. - 1.;
                } else
                    ndc += off * 2. / viewport;
                gl_Position = vec4(ndc * p.w, p.z, p.w);
                uv = (rect.xy + corner * rect.zw) / atlas_size;
                alpha = anchor_px.w;
            }
            `;
            const label_fs = `#version 300 es
            precision highp float;
            precision highp int;        // the same as in the vertex shader, leader_lines is used in both
            in vec2 uv;
            in float alpha;
            uniform sampler2D atlas;
            uniform int leader_lines;
            out vec4 out_col;
            void main() {
                if (leader_lines == 1) {
                    out_col = vec4(.85, .85, .85, 1) * .8 * alpha;   // light grey, premultiplied
                    return;
                }
                out_col = texture(atlas, uv) * alpha;   // premultiplied alpha
                if (out_col.a < .01)
                    discard;
            }
            `;
            this.line_program = initShaderProgram(gl, line_vs, line_fs);
            this.label_program = initShaderProgram(gl, label_vs, label_fs);
            const common_names = ["grid_offset_pos", "cam_pos", "eye_offset", "view_proj", "viewport", "pixel_angle", "lod_factor", "max_mesh_level",
                                  "m_per_uv", "virtual_heightmap_index", "virtual_heightmap"];
            const locations = (program, names) => {
                const u = {};
                for (const name of names)
                    u[name] = gl.getUniformLocation(program, name);
                u.heightmap_infos = gl.getUniformBlockIndex(program, "Infos_heightmap");
                return u;
            };
            this.line_uniforms = locations(this.line_program, [...common_names, "tile_origin", "tile_w", "tile_rect", "exclude_rect", "style_fill", "style_casing", "style_dims", "style_min_scale", "fill_pass"]);
            this.label_uniforms = locations(this.label_program, [...common_names, "atlas_size", "atlas", "snap_to_pixels", "leader_lines"]);
            gl.useProgram(this.line_program);
            gl.uniform4fv(this.line_uniforms.style_fill, vector_line_styles_3d.flatMap(st => st.col));
            gl.uniform4fv(this.line_uniforms.style_casing, vector_line_styles_3d.flatMap(st => st.casing));
            gl.uniform4fv(this.line_uniforms.style_dims, vector_line_styles_3d.flatMap(st => [st.w, st.casing_w, ...(st.dash || [0, 0])]));
            gl.uniform1fv(this.line_uniforms.style_min_scale, vector_line_styles_3d.map(st => st.min_scale || .3));
            gl.useProgram(null);
        },

        /**
         * @brief updates the rings for the camera position, requests missing and preloaded tiles and selects the drawn tiles.
         * Called each frame before drawing
         * @param {float} height_m camera height above the terrain in meters, selects the zoom level of the finest ring
         * @param {int} radius rings are (2 radius + 1)^2 tiles
         */
        update: function (cam_x, cam_y, height_m, radius) {
            const now = performance.now();
            const base = Math.min(Math.max(Math.round(14 - Math.log2(Math.max(height_m, 1500) / 1500)), 2), 14);
            const ring_at = (z, r) => {
                const n = 2 ** z;
                const cx = Math.floor(cam_x * n), cy = Math.floor(cam_y * n);
                const x0 = Math.max(cx - r, 0), x1 = Math.min(cx + r, n - 1);
                const y0 = Math.max(cy - r, 0), y1 = Math.min(cy + r, n - 1);
                const keys = [];
                for (let y = y0; y <= y1; ++y)
                    for (let x = x0; x <= x1; ++x)
                        keys.push(`${z}/${x}/${y}`);
                return {z, rect: [x0 / n, y0 / n, (x1 + 1) / n, (y1 + 1) / n], keys};
            };
            const rings = [];
            for (let k = 0; k < ring_count && base - 2 * k >= 0; ++k)
                rings.push(ring_at(base - 2 * k, radius));
            // preloaded: a margin around the two finest rings (moving) and the finest ring of the neighbor levels (camera height)
            const preload = [];
            for (const ring of rings.slice(0, 2))
                preload.push(...ring_at(ring.z, radius + 1).keys);
            for (const z of [base - 1, base + 1])
                if (z >= 0 && z <= 14)
                    preload.push(...ring_at(z, radius).keys);

            // not drawn, the fallback for the coarsest ring after a jump of the camera (only few small tiles)
            const fallback = ring_at(Math.max(rings[rings.length - 1].z - 2, 0), 1).keys;

            this.needed_keys = new Set(rings.flatMap(r => r.keys));
            // building names only for the tiles around the camera, they are loaded slowly
            this.housename_keys = new Set(base == 14 ? ring_at(14, 1).keys : []);
            for (const key of this.housename_keys) {
                const tile = this.tiles.get(key);
                if (tile && tile.state == "ready" && !tile.housenames)
                    this.refresh_labels(tile);
            }
            this.cam = {x: cam_x, y: cam_y};
            this.request_class = new Map();
            for (const key of preload)
                this.request_class.set(key, 1);
            for (const key of [...this.needed_keys, ...fallback])
                this.request_class.set(key, 2);
            // the missing tiles in priority order, only as many as fit into the queue of the loader (it would drop the
            // least important ones, which would be requested again in the next frame). The others follow in later updates
            const missing = [...this.request_class.keys()].filter(key => this.needs_request(key, now))
                                                          .map(key => [key, this.priority_of(key)()]).sort((a, b) => b[1] - a[1]);
            for (const [key] of missing) {
                if (VectorTileLoader.free_queue_slots() <= 0)
                    break;
                this.request(key, now);
            }
            const sig = rings.map(r => r.keys[0] + ":" + r.keys.length).join(",");
            if (!this.drawn || this.drawn.sig != sig || this.drawn.version != this.version)
                this.select_drawn(rings, sig);
            const keep = new Set([...this.needed_keys, ...preload, ...fallback]);
            for (const ring of this.drawn.rings)
                for (const entry of ring.entries) {
                    entry.tile.last_use = now;
                    keep.add(`${entry.tile.z}/${entry.tile.x}/${entry.tile.y}`);
                }
            for (const key of keep) {
                const tile = this.tiles.get(key);
                if (tile)
                    tile.last_use = now;
            }
            // room for the rings, the preloaded tiles and about as many cached ones
            this.evict(keep, 4 * ring_count * (2 * radius + 1) ** 2);
        },
        /** @returns {bool} true if the tile is neither loaded nor loading (or failed long enough ago) */
        needs_request: function (key, now) {
            const old = this.tiles.get(key);
            return !old || (old.state == "failed" && now - old.fail_time >= retry_ms);
        },
        /**
         * @returns {function():float} priority of the request of the tile, evaluated by the loader when a slot gets free:
         * needed before preloaded, coarse before fine (fallback of the fine tiles), close to the camera first
         */
        priority_of: function (key) {
            const [z, x, y] = key.split("/").map(Number);
            return () => {
                const n = 2 ** z;
                const d = Math.max(Math.abs(x + .5 - this.cam.x * n), Math.abs(y + .5 - this.cam.y * n));
                const local = 100000 - z * 1000 - Math.min(d, 999);
                const cls = this.request_class.get(key);
                return cls == 2 ? VectorTileLoader.needed_priority + local : cls == 1 ? VectorTileLoader.needed_priority / 2 + local : local;
            };
        },
        /** @brief requests the tile, see needs_request */
        request: function (key, now) {
            const old = this.tiles.get(key);
            if (old)
                this.release(old);
            const [z, x, y] = key.split("/").map(Number);
            const tile = {z, x, y, state: "loading", count: 0, vao: null, buffer: null, atlas: null, labels: [], last_use: now, fail_time: 0};
            this.tiles.set(key, tile);
            tile.housenames = this.housename_keys.has(key);
            VectorTileLoader.load_mesh(z, x, y, () => this.tiles.get(key) === tile, this.priority_of(key), tile.housenames).then((data) => {
                if (this.tiles.get(key) !== tile) {
                    if (data.atlas)
                        data.atlas.close();
                    return;
                }
                this.upload(tile, data);
                tile.state = "ready";
                ++this.version;
                if (tile.labels_dirty)
                    this.refresh_labels(tile);
                if (this.needed_keys.has(key) && this.on_change)
                    this.on_change();
            }, (err) => {
                if (this.tiles.get(key) !== tile)
                    return;
                // dropped from the full queue: forgotten, it is requested again while it is needed
                if (err.dropped) {
                    this.tiles.delete(key);
                    return;
                }
                console.warn(`Vector tile ${key} could not be loaded: ${err.message}`);
                tile.state = "failed";
                tile.fail_time = performance.now();
            });
        },
        /** @brief loads the labels of the tile again with the building names, the lines are kept */
        refresh_labels: function (tile) {
            const key = `${tile.z}/${tile.x}/${tile.y}`;
            tile.housenames = true;
            // a running request might not have the names yet, it is repeated once it finished
            if (tile.labels_loading) {
                tile.labels_dirty = true;
                return;
            }
            tile.labels_loading = true;
            tile.labels_dirty = false;
            VectorTileLoader.load_labels(tile.z, tile.x, tile.y, () => this.tiles.get(key) === tile, () => VectorTileLoader.needed_priority, true).then((data) => {
                tile.labels_loading = false;
                if (this.tiles.get(key) !== tile) {
                    if (data.atlas)
                        data.atlas.close();
                    return;
                }
                this.upload_labels(tile, data);
                ++this.version;
                if (this.on_change)
                    this.on_change();
                if (tile.labels_dirty)
                    this.refresh_labels(tile);
            }, (err) => {
                tile.labels_loading = false;
                // requested again by the next update
                if (err.dropped)
                    tile.housenames = false;
            });
        },
        /**
         * @brief selects for each tile of the rings the tile to draw: the tile itself or its deepest loaded ancestor,
         * which is clipped to the area of the tile. Collects the label candidates of the drawn areas in priority order
         */
        select_drawn: function (rings, sig) {
            const drawn = {sig, version: this.version, rings: [], labels: []};
            rings.forEach((ring, k) => {
                const exclude = k > 0 ? rings[k - 1].rect : null;
                const entries = [];
                for (const key of ring.keys) {
                    const [z, x, y] = key.split("/").map(Number);
                    const w = 1 / 2 ** z;
                    const rect = [x * w, y * w, (x + 1) * w, (y + 1) * w];
                    for (let az = z; az >= 0; --az) {
                        const tile = this.tiles.get(`${az}/${x >> (z - az)}/${y >> (z - az)}`);
                        if (tile && tile.state == "ready") {
                            entries.push({tile, rect});
                            break;
                        }
                    }
                }
                drawn.rings.push({exclude: exclude || [0, 0, 0, 0], entries});
                // labels in the area of the finer ring are left to it
                for (const {tile, rect} of entries)
                    for (const l of tile.labels)
                        if (l.gx >= rect[0] && l.gy >= rect[1] && l.gx < rect[2] && l.gy < rect[3] &&
                            !(exclude && l.gx >= exclude[0] && l.gy >= exclude[1] && l.gx < exclude[2] && l.gy < exclude[3]))
                            drawn.labels.push(l);
            });
            drawn.labels.sort((a, b) => a.prio - b.prio);
            this.drawn = drawn;
        },
        /** @brief releases the least important loaded tiles which are not in keep until at most max_tiles are left */
        evict: function (keep, max_tiles) {
            if (this.tiles.size <= max_tiles)
                return;
            const priority = (t) => t.last_use - t.z * coarse_level_priority_ms;
            const candidates = [...this.tiles].filter(([key, t]) => !keep.has(key) && t.state != "loading")
                                              .sort((a, b) => priority(a[1]) - priority(b[1]));
            for (const [key, tile] of candidates) {
                if (this.tiles.size <= max_tiles)
                    break;
                this.release(tile);
                this.tiles.delete(key);
            }
        },
        upload: function (tile, data) {
            const gl = this.gl;
            tile.count = data.segments.length / 8;
            if (tile.count) {
                tile.buffer = gl.createBuffer();
                tile.vao = gl.createVertexArray();
                gl.bindVertexArray(tile.vao);
                gl.bindBuffer(gl.ARRAY_BUFFER, tile.buffer);
                gl.bufferData(gl.ARRAY_BUFFER, data.segments, gl.STATIC_DRAW);
                for (let a = 0; a < 2; ++a) {
                    gl.enableVertexAttribArray(a);
                    gl.vertexAttribPointer(a, 4, gl.FLOAT, false, 32, a * 16);
                    gl.vertexAttribDivisor(a, 1);
                }
                gl.bindVertexArray(null);
                gl.bindBuffer(gl.ARRAY_BUFFER, null);
            }
            this.upload_labels(tile, data);
        },
        upload_labels: function (tile, data) {
            const gl = this.gl;
            if (tile.atlas)
                gl.deleteTexture(tile.atlas);
            tile.atlas = null;
            if (data.atlas) {
                tile.atlas = gl.createTexture();
                tile.atlas_w = data.atlas.width;
                tile.atlas_h = data.atlas.height;
                gl.bindTexture(gl.TEXTURE_2D, tile.atlas);
                gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
                gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, data.atlas);
                gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
                gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
                gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
                gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
                gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
                gl.bindTexture(gl.TEXTURE_2D, null);
                data.atlas.close();
            }
            const w = 1 / 2 ** tile.z;
            tile.labels = data.labels.map(l => ({...l, tile, gx: (tile.x + l.x) * w, gy: (tile.y + l.y) * w, h_m: null, h_time: -Infinity,
                                                 lift_m: l.hx === undefined ? label_lift_m : street_label_lift_m,
                                                 hx: l.hx === undefined ? undefined : l.hx * w, hy: l.hy === undefined ? undefined : l.hy * w}));
        },
        release: function (tile) {
            const gl = this.gl;
            if (tile.buffer) gl.deleteBuffer(tile.buffer);
            if (tile.vao) gl.deleteVertexArray(tile.vao);
            if (tile.atlas) gl.deleteTexture(tile.atlas);
        },
        set_common_uniforms: function (u, program, p) {
            const gl = this.gl;
            gl.useProgram(program);
            p.virtual_height_map.bind_to_shader(gl.TEXTURE0, gl.TEXTURE1, u.heightmap_infos);
            gl.uniform1i(u.virtual_heightmap_index, 0);
            gl.uniform1i(u.virtual_heightmap, 1);
            gl.uniformBlockBinding(program, u.heightmap_infos, u.heightmap_infos);
            gl.uniformMatrix4fv(u.view_proj, false, p.view_proj);
            gl.uniform2f(u.grid_offset_pos, p.grid_offset_pos.x, p.grid_offset_pos.y);
            gl.uniform3f(u.cam_pos, p.cam_pos[0], p.cam_pos[1], p.cam_pos[2]);
            gl.uniform1f(u.eye_offset, p.eye_offset || 0);
            gl.uniform2f(u.viewport, p.viewport[0], p.viewport[1]);
            gl.uniform1f(u.lod_factor, p.lod_factor);
            gl.uniform1f(u.pixel_angle, p.pixel_angle);
            gl.uniform1i(u.max_mesh_level, p.max_mesh_level);
            gl.uniform1f(u.m_per_uv, p.m_per_uv);
        },
        /** @param {Object} p same parameters as for TrackRenderer.draw and m_per_uv */
        draw_lines: function (p) {
            if (!this.drawn)
                return;
            const gl = this.gl;
            const u = this.line_uniforms;
            this.set_common_uniforms(u, this.line_program, p);
            const ox = p.grid_offset_pos.x, oy = p.grid_offset_pos.y;
            gl.enable(gl.BLEND);
            gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
            gl.depthMask(false);
            gl.depthFunc(gl.LEQUAL);
            // the pieces are sorted by style in each tile, so the more important lines are drawn over the others
            for (let pass = 0; pass < 2; ++pass) {
                gl.uniform1i(u.fill_pass, pass);
                for (const ring of this.drawn.rings) {
                    const ex = ring.exclude;
                    gl.uniform4f(u.exclude_rect, ex[0] - ox, ex[1] - oy, ex[2] - ox, ex[3] - oy);
                    for (const {tile, rect} of ring.entries) {
                        if (!tile.count)
                            continue;
                        const w = 1 / 2 ** tile.z;
                        gl.uniform2f(u.tile_origin, tile.x * w - ox, tile.y * w - oy);
                        gl.uniform1f(u.tile_w, w);
                        gl.uniform4f(u.tile_rect, rect[0] - ox, rect[1] - oy, rect[2] - ox, rect[3] - oy);
                        gl.bindVertexArray(tile.vao);
                        gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, tile.count);
                    }
                }
            }
            gl.bindVertexArray(null);
            gl.disable(gl.BLEND);
            gl.depthMask(true);
            gl.depthFunc(gl.LESS);
        },
        /**
         * @brief places the labels on the screen (in priority order, overlapping ones are left out) and draws them
         * @param {Object} p as for draw_lines and height_at(x, y) -> terrain height in meters or null, label_depth
         * {data, width, height, view_proj, view, grid_offset: {x, y}, eye_offset}: the read back linear depth of the tile id
         * pass with its camera, null if there is none (the shader tests the visibility then)
         */
        draw_labels: function (p) {
            if (!this.drawn || !this.drawn.labels.length)
                return;
            const gl = this.gl;
            const e = p.view_proj;
            const vw = p.viewport[0], vh = p.viewport[1];
            const ox = p.grid_offset_pos.x, oy = p.grid_offset_pos.y;
            const now = performance.now();
            const dt = this.label_time ? Math.min(now - this.label_time, 100) : 0;
            this.label_time = now;
            const project = (x, y, z) => {
                const cw = e[3] * x + e[7] * y + e[11] * z + e[15];
                if (cw <= 1e-9)
                    return null;
                return [((e[0] * x + e[4] * y + e[8] * z + e[12]) / cw * .5 + .5) * vw,
                        (.5 - (e[1] * x + e[5] * y + e[9] * z + e[13]) / cw * .5) * vh];
            };
            // collision grid of the placed label boxes
            const cell = 64;
            const grid = new Map();
            const cells = (b, f) => {
                for (let cy = Math.floor(b[1] / cell); cy <= Math.floor(b[3] / cell); ++cy)
                    for (let cx = Math.floor(b[0] / cell); cx <= Math.floor(b[2] / cell); ++cx)
                        if (f(cy * 4096 + cx) === false)
                            return false;
                return true;
            };
            const free = (b) => cells(b, (c) => !(grid.get(c) || []).some(o => o[0] < b[2] && o[2] > b[0] && o[1] < b[3] && o[3] > b[1]));
            const placed = [];
            // the labels shown in the last frame are placed first (in priority order), otherwise small changes of the
            // boxes while moving let labels flicker between being shown and being hidden by a neighbor
            const candidates = this.drawn.labels;
            // a label of a newly drawn tile (other zoom level of the rings) takes over the state of the same label of the
            // last frame (same position up to ~5 m), it would fade in again and wait for a depth test otherwise
            const pos_key = (l) => l.pos_key || (l.pos_key = `${Math.round(l.gx * 2 ** 23)}|${Math.round(l.gy * 2 ** 23)}`);
            const last = this.label_states || new Map();
            for (const l of candidates)
                if (l.alpha === undefined) {
                    const o = last.get(pos_key(l));
                    if (o && o !== l)
                        Object.assign(l, {alpha: o.alpha, shown: o.shown, visible: o.visible, angle: o.angle});
                    else
                        l.alpha = 0;
                }
            // visibility from the depth of the last tile id pass (cpu readback, with the camera of that pass)
            const dc = p.label_depth;
            const depth_visible = (l, z) => {
                const x = l.gx - dc.grid_offset.x, y = l.gy - dc.grid_offset.y, v = dc.view_proj;
                const cw = v[3] * x + v[7] * y + v[11] * z + v[15];
                if (cw <= 1e-9)
                    return -1;
                const nx = (v[0] * x + v[4] * y + v[8] * z + v[12]) / cw, ny = (v[1] * x + v[5] * y + v[9] * z + v[13]) / cw;
                if (Math.abs(nx) > 1 || Math.abs(ny) > 1)
                    return -1;  // not in that view, e.g. a label coming in from the side
                const px = Math.floor((nx * .5 + .5) * dc.width), py = Math.floor((ny * .5 + .5) * dc.height);
                // the farthest terrain of the 3x3 pixels around the anchor, labels at a ridge stay visible at the coarse resolution
                let far = -Infinity;
                for (let dy = -1; dy <= 1; ++dy)
                    for (let dx = -1; dx <= 1; ++dx) {
                        const qx = Math.min(Math.max(px + dx, 0), dc.width - 1), qy = Math.min(Math.max(py + dy, 0), dc.height - 1);
                        const d = dc.data[qy * dc.width + qx];
                        if (!(d > 0))
                            return 1;   // no terrain there (sky)
                        far = Math.max(far, d + dc.eye_offset);
                    }
                const w = dc.view;
                const depth = -(w[2] * x + w[6] * y + w[10] * z + w[14]);
                return far < depth - Math.max(Util.m_to_wgs_84_uv(label_occlusion_m), .04 * depth) ? 0 : 1;
            };
            const order = [...candidates.filter(l => l.shown), ...candidates.filter(l => !l.shown)];
            for (const l of candidates) {
                l.was_shown = l.shown;
                l.shown = false;
            }
            for (const l of order) {
                if (placed.length >= max_labels)
                    break;
                if (now - l.h_time > 1000) {
                    // peaks know their height, the terrain height is only an approximation for the placement
                    const h = l.ele != null ? l.ele : p.height_at(l.gx, l.gy);
                    if (h !== null) {
                        l.h_m = h;
                        l.h_time = now;
                    }
                }
                const z = Util.m_to_wgs_84_uv((l.h_m || 0) + l.lift_m) * 1.4;
                // points of interest and house numbers only close to the camera (the eye offset of the 2d transition is not counted)
                if (l.max_dist && (Math.hypot(l.gx - ox - p.cam_pos[0], l.gy - oy - p.cam_pos[1], z - p.cam_pos[2]) - (p.eye_offset || 0)) * p.m_per_uv > l.max_dist)
                    continue;
                const s = project(l.gx - ox, l.gy - oy, z);
                if (!s || s[0] < -200 || s[0] > vw + 200 || s[1] < -200 || s[1] > vh + 200)
                    continue;
                l.fade_out = false;
                if (dc) {
                    // shown only after a successful test, a label outside of the view of the depth counts as occluded
                    // (coming in from the side after a rotation, it waits for the depth of its area). An occluded label which
                    // was shown fades out at its place
                    l.visible = depth_visible(l, z) == 1;
                    if (!l.visible && !(l.was_shown && l.alpha > 0))
                        continue;
                    l.fade_out = !l.visible;
                }
                let angle = 0;
                if (l.hx !== undefined) {
                    // street names along the street on the screen, only if they fit on the segment
                    const a = project(l.gx - l.hx - ox, l.gy - l.hy - oy, z), b = project(l.gx + l.hx - ox, l.gy + l.hy - oy, z);
                    if (!a || !b || Math.hypot(b[0] - a[0], b[1] - a[1]) < l.w + 8)
                        continue;
                    angle = -Math.atan2(b[1] - a[1], b[0] - a[0]);
                    if (angle > Math.PI / 2) angle -= Math.PI;
                    if (angle < -Math.PI / 2) angle += Math.PI;
                }
                let box;
                if (angle) {
                    const c = Math.abs(Math.cos(angle)), si = Math.abs(Math.sin(angle));
                    const hw = (l.w * c + l.h * si) / 2, hh = (l.w * si + l.h * c) / 2;
                    box = [s[0] - hw, s[1] - hh, s[0] + hw, s[1] + hh];
                } else if (l.lift_m >= label_lift_m / 2)
                    box = [s[0] - l.ax, s[1] - l.h, s[0] - l.ax + l.w, s[1]];     // standing on its line (see the shader)
                else
                    box = [s[0] - l.ax, s[1] - l.ay, s[0] - l.ax + l.w, s[1] - l.ay + l.h];
                if (box[2] < 0 || box[0] > vw || box[3] < 0 || box[1] > vh || !free(box))
                    continue;
                cells(box, (c) => { if (!grid.has(c)) grid.set(c, []); grid.get(c).push(box); });
                l.shown = true;
                l.angle = angle;
                placed.push({l, angle});
            }
            // the labels which are not placed anymore fade out at their last placement, they reserve no space
            let fading = false;
            for (const l of placed.map(e => e.l)) {
                l.alpha = l.fade_out ? Math.max(l.alpha - dt / label_fade_out_ms, 0) : Math.min((l.alpha || 0) + dt / label_fade_in_ms, 1);
                fading |= l.alpha > 0 && l.alpha < 1;
            }
            for (const l of candidates) {
                if (l.shown || !(l.alpha > 0))
                    continue;
                l.alpha = Math.max(l.alpha - dt / label_fade_out_ms, 0);
                if (l.alpha > 0 && placed.length < max_labels) {
                    placed.push({l, angle: l.angle || 0});
                    fading = true;
                }
            }
            this.label_states = new Map();
            for (const l of candidates)
                if (l.alpha > 0 || l.visible)
                    this.label_states.set(pos_key(l), l);
            if (fading && this.on_change)
                this.on_change();
            if (!placed.length)
                return;
            // grouped by tile, each tile has its own atlas
            placed.sort((a, b) => a.l.tile === b.l.tile ? 0 : (a.l.tile.z * 1e12 + a.l.tile.y * 1e6 + a.l.tile.x) - (b.l.tile.z * 1e12 + b.l.tile.y * 1e6 + b.l.tile.x));
            const d = this.label_data;
            placed.forEach(({l, angle}, i) => {
                d.set([l.gx - ox, l.gy - oy, angle, l.lift_m, l.atlas_x, l.atlas_y, l.w, l.h, l.ax, l.ay, dc ? 0 : 1, l.alpha], i * label_floats);
            });
            const u = this.label_uniforms;
            this.set_common_uniforms(u, this.label_program, p);
            const moving = !this.last_view_proj || p.view_proj.some((v, i) => v != this.last_view_proj[i]);
            this.last_view_proj = Float32Array.from(p.view_proj);
            gl.uniform1i(u.snap_to_pixels, moving ? 0 : 1);
            // one more frame once the camera stopped, the labels are aligned to the pixels then
            if (moving && this.on_change)
                this.on_change();
            gl.bindBuffer(gl.ARRAY_BUFFER, this.label_buffer);
            gl.bufferSubData(gl.ARRAY_BUFFER, 0, d, 0, placed.length * label_floats);
            gl.bindVertexArray(this.label_vao);
            gl.enable(gl.BLEND);
            gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
            gl.disable(gl.DEPTH_TEST);      // occlusion is tested per label in the vertex shader
            gl.activeTexture(gl.TEXTURE6);
            gl.uniform1i(u.atlas, 6);
            // the lines down to the terrain first, the labels are drawn over them (all at once, they need no atlas)
            gl.uniform1i(u.leader_lines, 1);
            for (let a = 0; a < 3; ++a)
                gl.vertexAttribPointer(a, 4, gl.FLOAT, false, label_floats * 4, a * 16);
            gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, placed.length);
            gl.uniform1i(u.leader_lines, 0);
            for (let i = 0; i < placed.length;) {
                const tile = placed[i].l.tile;
                let j = i;
                while (j < placed.length && placed[j].l.tile === tile)
                    ++j;
                gl.bindTexture(gl.TEXTURE_2D, tile.atlas);
                gl.uniform2f(u.atlas_size, tile.atlas_w, tile.atlas_h);
                // no base instance in webgl2, the attribute pointers are moved to the first label of the tile instead
                for (let a = 0; a < 3; ++a)
                    gl.vertexAttribPointer(a, 4, gl.FLOAT, false, label_floats * 4, (i * label_floats + a * 4) * 4);
                gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, j - i);
                i = j;
            }
            gl.bindVertexArray(null);
            gl.bindBuffer(gl.ARRAY_BUFFER, null);
            gl.disable(gl.BLEND);
            gl.enable(gl.DEPTH_TEST);
        },
    };
};
