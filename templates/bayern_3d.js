// 3d buildings (LoD2) of the Bayerische Vermessungsverwaltung (geodaten.bayern.de, data of the BayernAtlas 3d view).
// The buildings are a 3d tiles tileset of b3dm tiles (glTF 1.0 with CESIUM_RTC) in a geographic quadtree, refined by
// adding buildings (refine ADD): the finer levels have the smaller buildings and are loaded closer to the camera.
// The tiles are parsed in a worker into vertices on our map (uv and height above the ground of the building), each
// building stands on our terrain. Roofs show the map below them (the aerial image shows the roofs), walls are light grey.
// Has to be loaded after virtual_texture.js

/**
 * @brief code running in the worker, it is converted to a string, so it must not use anything from outside
 */
const bayern_3d_worker_main = () => {
    const text_decoder = new TextDecoder();
    const wall_floats = 10;     // per vertex: x, y (uv relative to the tile origin), height above the building ground (m),
                                // building center x, y (as the position), ground height of the building (m in the heights
                                // of the tileset), 1 for wall corners at the ground, -1 for bridges, normal east, south, up

    // wgs 84 ellipsoid
    const a = 6378137, e2 = 6.69437999014e-3;
    const geodetic = (x, y, z) => {
        const lon = Math.atan2(y, x), p = Math.hypot(x, y);
        let lat = Math.atan2(z, p * (1 - e2)), h = 0;
        for (let i = 0; i < 5; ++i) {
            const n = a / Math.sqrt(1 - e2 * Math.sin(lat) ** 2);
            h = p / Math.cos(lat) - n;
            lat = Math.atan2(z, p * (1 - e2 * n / (n + h)));
        }
        return [lon, lat, h];
    };
    const uv_of = (lon, lat) => [(lon / Math.PI + 1) / 2, (1 - Math.asinh(Math.tan(lat)) / Math.PI) / 2];
    // column major 4x4 matrices as in gltf
    const mat_mul = (m, n) => {
        const r = new Array(16).fill(0);
        for (let c = 0; c < 4; ++c)
            for (let row = 0; row < 4; ++row)
                for (let k = 0; k < 4; ++k)
                    r[c * 4 + row] += m[k * 4 + row] * n[c * 4 + k];
        return r;
    };
    const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
    const component_size = {5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4};
    const type_size = {SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4};
    const read_accessor = (gltf, body, id) => {
        const acc = gltf.accessors[id], view = gltf.bufferViews[acc.bufferView];
        const comps = type_size[acc.type], size = component_size[acc.componentType];
        const stride = acc.byteStride || view.byteStride || comps * size;
        const dv = new DataView(body.buffer, body.byteOffset + (view.byteOffset || 0) + (acc.byteOffset || 0));
        const get = {5120: (o) => dv.getInt8(o), 5121: (o) => dv.getUint8(o), 5122: (o) => dv.getInt16(o, true),
                     5123: (o) => dv.getUint16(o, true), 5125: (o) => dv.getUint32(o, true), 5126: (o) => dv.getFloat32(o, true)}[acc.componentType];
        const out = new Float64Array(acc.count * comps);
        for (let i = 0; i < acc.count; ++i)
            for (let c = 0; c < comps; ++c)
                out[i * comps + c] = get(i * stride + c * size);
        return out;
    };

    /**
     * @brief b3dm with the header of the current spec (28 bytes) or the legacy headers (20 or 24 bytes, detected as in
     * cesium by too large byte lengths), embedded binary glTF 1.0
     * @returns {{gltf, body: Uint8Array, batch_table}} batch_table: json, null if there is none
     */
    const parse_b3dm = (buf) => {
        const dv = new DataView(buf);
        if (dv.getUint32(0, true) != 0x6d643362)    // "b3dm"
            throw new Error("no b3dm tile");
        const legacy = 570425344;
        let o = 28, bt = [0, 0];     // offset and length of the batch table json
        const [f3, f4, f5, f6] = [3, 4, 5, 6].map(i => dv.getUint32(4 * i, true));
        if (f5 >= legacy) {                 // [batch length, batch table length]
            o = 20 + f4;
            bt = [20, f4];
        } else if (f6 >= legacy) {          // [batch table json length, batch table binary length, batch length]
            o = 24 + f3 + f4;
            bt = [24, f3];
        } else {
            o = 28 + f3 + f4 + f5 + f6;
            bt = [28 + f3 + f4, f5];
        }
        let batch_table = null;
        try {
            batch_table = bt[1] ? JSON.parse(text_decoder.decode(new Uint8Array(buf, bt[0], bt[1]))) : null;
        } catch (e) {}
        const glb = new DataView(buf, o);
        if (glb.getUint32(0, true) != 0x46546c67)   // "glTF"
            throw new Error("no binary glTF in the b3dm tile");
        if (glb.getUint32(4, true) != 1)
            throw new Error("only glTF 1.0 is supported");
        const json_length = glb.getUint32(12, true);
        const gltf = JSON.parse(text_decoder.decode(new Uint8Array(buf, o + 20, json_length)));
        return {gltf, body: new Uint8Array(buf, o + 20 + json_length), batch_table};
    };

    /**
     * @returns {{vertices: Float32Array, origin: [x, y]}} triangles of the walls and roofs (the ground surfaces are left
     * out), see wall_floats. The vertices are relative to origin in uv
     */
    const build_tile = (buf) => {
        const {gltf, body, batch_table} = parse_b3dm(buf);
        // bridges (alkis function 53001_*, bauwerk im verkehrsbereich) keep their own height, the terrain below them is
        // the valley or road crossed
        const attributes = batch_table && Array.isArray(batch_table.attributes) ? batch_table.attributes : [];
        const is_bridge = (batch_id) => /^53001/.test((attributes[batch_id] || {}).function || "");
        const rtc = gltf.extensions && gltf.extensions.CESIUM_RTC ? gltf.extensions.CESIUM_RTC.center : [0, 0, 0];
        // all triangles in earth fixed coordinates: the node matrices, then the y up of gltf to the z up of 3d tiles
        const prims = [];
        const visit = (id, parent) => {
            const node = gltf.nodes[id];
            const m = mat_mul(parent, node.matrix || identity);
            for (const mesh_id of node.meshes || [])
                for (const prim of gltf.meshes[mesh_id].primitives)
                    prims.push({prim, m});
            for (const child of node.children || [])
                visit(child, m);
        };
        const scene = gltf.scenes ? gltf.scenes[gltf.scene || Object.keys(gltf.scenes)[0]] : null;
        for (const id of scene ? scene.nodes : Object.keys(gltf.nodes))
            visit(id, identity);
        const tris = [];    // per vertex: lon, lat, h, normal e, n, u, batch id
        for (const {prim, m} of prims) {
            if ((prim.mode ?? 4) != 4)
                continue;
            const pos = read_accessor(gltf, body, prim.attributes.POSITION);
            const nor = prim.attributes.NORMAL ? read_accessor(gltf, body, prim.attributes.NORMAL) : null;
            const batch = prim.attributes._BATCHID ? read_accessor(gltf, body, prim.attributes._BATCHID) : null;
            const idx = prim.indices ? read_accessor(gltf, body, prim.indices) : null;
            const count = idx ? idx.length : pos.length / 3;
            for (let k = 0; k < count; ++k) {
                const i = idx ? idx[k] : k;
                const px = pos[3 * i], py = pos[3 * i + 1], pz = pos[3 * i + 2];
                // node matrix, y up to z up (x, y, z) -> (x, -z, y), rtc center
                const tx = m[0] * px + m[4] * py + m[8] * pz + m[12], ty = m[1] * px + m[5] * py + m[9] * pz + m[13], tz = m[2] * px + m[6] * py + m[10] * pz + m[14];
                const [lon, lat, h] = geodetic(tx + rtc[0], -tz + rtc[1], ty + rtc[2]);
                let ne = 0, nn = 0, nu = 1;
                if (nor) {
                    const qx = nor[3 * i], qy = nor[3 * i + 1], qz = nor[3 * i + 2];
                    // earth fixed as for the position
                    const ex = m[0] * qx + m[4] * qy + m[8] * qz, ey = -(m[2] * qx + m[6] * qy + m[10] * qz), ez = m[1] * qx + m[5] * qy + m[9] * qz;
                    // east, north, up of the ellipsoid at the vertex
                    const so = Math.sin(lon), co = Math.cos(lon), sa = Math.sin(lat), ca = Math.cos(lat);
                    ne = -so * ex + co * ey;
                    nn = -sa * co * ex - sa * so * ey + ca * ez;
                    nu = ca * co * ex + ca * so * ey + sa * ez;
                }
                tris.push(lon, lat, h, ne, nn, nu, batch ? batch[i] : 0);
            }
        }
        // the ground surface (normal down) of each building: its mean height is the ground of the building (for bridges
        // the underside of the deck), the shader places it on our terrain at its center (see the vertex shader). The
        // wall vertices at the ground corners are marked to be moved down a bit there, no gaps on slopes
        const buildings = new Map();    // batch id -> {lon, lat, h, n, corners: Map}
        const key = (i) => `${Math.round(tris[i] * 1e8)}|${Math.round(tris[i + 1] * 1e8)}`;
        for (let i = 0; i < tris.length; i += 7) {
            if (tris[i + 5] > -.5)
                continue;
            const b = buildings.get(tris[i + 6]) || {lon: 0, lat: 0, h: 0, n: 0, corners: new Map()};
            b.lon += tris[i]; b.lat += tris[i + 1]; b.h += tris[i + 2]; ++b.n;
            b.corners.set(key(i), tris[i + 2]);
            buildings.set(tris[i + 6], b);
        }
        // buildings without a ground surface: lowest vertex and the mean position
        for (let i = 0; i < tris.length; i += 7)
            if (!buildings.has(tris[i + 6]) || buildings.get(tris[i + 6]).fallback) {
                const b = buildings.get(tris[i + 6]) || {lon: 0, lat: 0, h: Infinity, n: 0, corners: new Map(), fallback: true};
                b.lon += tris[i]; b.lat += tris[i + 1]; b.h = Math.min(b.h, tris[i + 2]); ++b.n;
                buildings.set(tris[i + 6], b);
            }
        for (const b of buildings.values()) {
            b.lon /= b.n; b.lat /= b.n;
            if (!b.fallback)
                b.h /= b.n;
            b.uv = uv_of(b.lon, b.lat);
        }
        const origin = tris.length ? uv_of(tris[0], tris[1]) : [0, 0];
        const out = new Float32Array(tris.length / 7 * wall_floats);
        let n = 0;
        for (let i = 0; i < tris.length; i += 21) {
            // ground surfaces are below the terrain anyway
            if (tris[i + 5] < -.5 && tris[i + 12] < -.5 && tris[i + 19] < -.5)
                continue;
            for (let j = i; j < i + 21; j += 7) {
                const b = buildings.get(tris[j + 6]);
                const [x, y] = uv_of(tris[j], tris[j + 1]);
                const corner = b.corners.get(key(j));
                const at_ground = corner !== undefined && Math.abs(corner - tris[j + 2]) < .05;
                out.set([x - origin[0], y - origin[1], tris[j + 2] - b.h, b.uv[0] - origin[0], b.uv[1] - origin[1],
                         b.h, is_bridge(tris[j + 6]) ? -1 : at_ground ? 1 : 0, tris[j + 3], -tris[j + 4], tris[j + 5]], n);
                n += wall_floats;
            }
        }
        // ground of each building (no bridges), to match the heights of the tileset with our terrain
        const grounds = new Float32Array(buildings.size * 3);
        let k = 0;
        for (const [batch_id, b] of buildings)
            if (!is_bridge(batch_id)) {
                grounds.set([b.uv[0] - origin[0], b.uv[1] - origin[1], b.h], k);
                k += 3;
            }
        return {vertices: out.slice(0, n), origin, grounds: grounds.slice(0, k)};
    };

    self.onmessage = async (e) => {
        const {id, url} = e.data;
        try {
            const r = await fetch(url);
            if (!r.ok)
                throw new Error(`${r.status}`);
            const {vertices, origin, grounds} = build_tile(await r.arrayBuffer());
            self.postMessage({id, vertices, origin, grounds}, [vertices.buffer, grounds.buffer]);
        } catch (err) {
            self.postMessage({id, error: String(err.message || err)});
        }
    };
};

/**
 * @brief traverses the tileset of the buildings (tileset files are loaded when reached), loads the tiles close enough
 * to the camera (screen space error of their parent too large) and draws them on the terrain. Tiles fade in and out
 * (dithered, no sorting needed)
 */
const BuildingRenderer = () => {
    const tileset_url = "https://bvv3d22.bayernwolke.de/3d-data/latest/lod23d/tileset.json";
    const max_sse_px = 24;          // children are shown if the geometric error of their parent is larger on the screen
    const max_loading = 6;
    const max_tiles = 400;          // tiles kept on the gpu
    const fade_ms = 500;
    const retry_ms = 30000;
    const offset_interval_ms = 1000;
    const offset_samples = 16;      // buildings per tile for the height offset
    const floats = 10;
    const extend_down_m = 3;        // walls on the terrain reach this far below the ground, the terrain differs a bit from the one of the models
    const elevated_m = [4, 8];      // objects this far above our terrain keep their own height (bridges), blended in between
    return {
        /** @type {WebGL2RenderingContext} */
        gl: null,
        program: null,
        u: {},
        root: null,             // node: {region, ge, content, external, children, state, ...}, see make_node
        root_state: "none",
        worker: null,
        requests: new Map(),    // request id -> node
        next_id: 1,
        loading: 0,
        tiles: new Set(),       // nodes with content on the gpu (or fading)
        wanted: [],             // nodes selected in the last update, by distance
        on_change: null,        // called if a tile finished loading or a fade is running
        terrain_height: null,   // (x, y) -> height of our terrain in meters, null if not loaded
        height_offset: 0,      // added to the heights of the tileset (above the sea as ours), median of our terrain minus the building grounds
        offset_time: -Infinity,

        init: function (gl, virtual_height_map, virtual_street_map, height_level_offset, terrain_height) {
            this.gl = gl;
            this.terrain_height = terrain_height;
            this.create_program(virtual_height_map, virtual_street_map, height_level_offset);
            this.worker = new Worker(URL.createObjectURL(new Blob([`(${bayern_3d_worker_main.toString()})()`], {type: "text/javascript"})));
            this.worker.onmessage = (e) => this.on_tile(e.data);
            return this;
        },
        /** @brief (re)creates the shader program, needed again if a setting compiled into the shaders changes (seamless_tiles) */
        create_program: function (virtual_height_map, virtual_street_map, height_level_offset) {
            const gl = this.gl;
            if (this.program)
                gl.deleteProgram(this.program);
            const header = `#version 300 es
            precision highp int;
            precision highp float;
            precision highp sampler2D;
            precision highp sampler2DArray;
            precision highp usampler2DArray;
            uniform vec2 grid_offset_pos;
            uniform vec3 cam_pos;               // relative to grid_offset_pos
            uniform mat4 view_proj;
            uniform float lod_factor;
            uniform int max_mesh_level;
            uniform vec2 tile_origin;           // relative to grid_offset_pos
            uniform float fade;
            uniform float height_offset;        // added to the heights of the tileset
            ${Util.glsl_virtual_texture_uniforms("heightmap", virtual_height_map)}
            ${Util.glsl_virtual_texture_uniforms("streetmap", virtual_street_map)}
            ${Util.glsl_virtual_texture_load("streetmap")}
            ${Util.glsl_virtual_heightmap_load()}
            ${Util.glsl_wgs_84_m_to_uv()}
            `;
            const vs = header + `
            layout(location = 0) in vec3 pos;       // uv relative to the tile origin, height above the ground of the building in meters
            layout(location = 1) in vec4 center;    // center of the building (relative to the tile origin), its ground height
                                                    // in the heights of the tileset, 1 for wall corners at the ground,
                                                    // -1 for bridges (they keep their own height)
            layout(location = 2) in vec3 normal;    // east, south, up
            out vec3 v_normal;
            out vec2 v_pos;
            void main() {
                // the ground of the building on the terrain at its center, with the level the terrain mesh has there
                vec2 c = tile_origin + center.xy;
                float dist = max(length(c - cam_pos.xy), 1e-12);
                float mesh_level = clamp(ceil(log2(lod_factor / dist)), 0., float(max_mesh_level));
                float terrain = virtual_heightmap_load(grid_offset_pos, c, max(mesh_level + ${height_level_offset}., 0.)).x;
                // bridges and objects clearly above our terrain keep their own height
                float own = center.z + height_offset;
                float elevated = center.w < 0. ? 1. : smoothstep(${elevated_m[0]}., ${elevated_m[1]}., own - terrain);
                float ground = mix(terrain, own, elevated);
                float z = ground + pos.z - max(center.w, 0.) * ${extend_down_m}. * (1. - elevated);
                vec3 p = vec3(tile_origin + pos.xy, wgs_84_m_to_uv(z) * 1.4);
                v_normal = normal;
                v_pos = p.xy;
                gl_Position = view_proj * vec4(p, 1);
            }
            `;
            const fs = header + `
            in vec3 v_normal;
            in vec2 v_pos;
            out vec4 out_col;
            void main() {
                // fading by dithering (4x4 bayer matrix), the buildings need no sorting
                ivec2 q = ivec2(gl_FragCoord.xy) & 3;
                const float bayer[16] = float[16](0., 8., 2., 10., 12., 4., 14., 6., 3., 11., 1., 9., 15., 7., 13., 5.);
                if (fade < 1. && (bayer[q.y * 4 + q.x] + .5) / 16. > fade)
                    discard;
                vec3 n = normalize(v_normal);
                float light = dot(vec3(0, .7, .7), n) * .5 + .5;    // as the terrain
                vec3 col;
                if (n.z > .25) {
                    // roof: the map below, mostly the aerial image of the roof. The level from the size of a pixel on the map
                    vec2 fw = max(abs(dFdx(v_pos)), abs(dFdy(v_pos)));
                    float level = clamp(-log2(max(fw.x, fw.y) * 256.) + 1., 0., 30.);
                    vec4 map = virtual_streetmap_load(grid_offset_pos, v_pos, level);
                    col = (map == vec4(0) ? vec3(.62, .36, .3) : map.rgb) * (.8 + .25 * light);
                } else
                    col = vec3(.86) * (.55 + .5 * light);
                out_col = vec4(col, 1);
            }
            `;
            this.program = initShaderProgram(gl, vs, fs);
            const u = {};
            for (const name of ["grid_offset_pos", "cam_pos", "view_proj", "lod_factor", "max_mesh_level", "tile_origin", "fade", "height_offset",
                                "virtual_heightmap_index", "virtual_heightmap", "virtual_streetmap_index", "virtual_streetmap"])
                u[name] = gl.getUniformLocation(this.program, name);
            u.heightmap_infos = gl.getUniformBlockIndex(this.program, "Infos_heightmap");
            u.streetmap_infos = gl.getUniformBlockIndex(this.program, "Infos_streetmap");
            this.u = u;
        },

        make_node: function (json, base_url) {
            const c = json.content && (json.content.uri || json.content.url);
            const url = c ? new URL(c, base_url).href : null;
            const external = url && /\.json(\?|$)/.test(url);
            const r = json.boundingVolume.region;
            const deg = 180 / Math.PI;
            // region in uv (y is flipped: north is the smaller y)
            const to_uv = (lon, lat) => [(lon * deg + 180) / 360, (1 - Math.asinh(Math.tan(lat)) / Math.PI) / 2];
            const [x0, y1] = to_uv(r[0], r[1]), [x1, y0] = to_uv(r[2], r[3]);
            return {rect: [x0, y0, x1, y1], h: [r[4], r[5]], ge: json.geometricError,
                    content: external ? null : url, external: external ? url : null,
                    children: (json.children || []).map(child => this.make_node(child, base_url)),
                    state: "none", fade: 0, last_use: 0, fail_time: 0};
        },
        load_external: function (node) {
            node.state = "loading";
            fetch(node.external).then(r => {
                if (!r.ok)
                    throw new Error(`${r.status}`);
                return r.json();
            }).then(t => {
                node.children = [this.make_node(t.root, node.external)];
                node.state = "ready";
                if (this.on_change)
                    this.on_change();
            }, (e) => {
                console.warn(`building tileset ${node.external} could not be loaded: ${e.message}`);
                node.state = "failed";
                node.fail_time = performance.now();
            });
        },

        /**
         * @brief selects the tiles for the camera, loads missing ones (closest first)
         * @param {float} cam_x, cam_y camera position in uv, cam_h_m its height above the sea, m_per_uv at the camera,
         * screen_h in pixels, fov_rad vertical field of view
         */
        update: function (cam_x, cam_y, cam_h_m, m_per_uv, screen_h, fov_rad) {
            const now = performance.now();
            if (!this.root && this.root_state == "none") {
                this.root_state = "loading";
                fetch(tileset_url).then(r => r.json()).then(t => {
                    this.root = this.make_node(t.root, tileset_url);
                    this.root_state = "ready";
                    if (this.on_change)
                        this.on_change();
                }, (e) => {
                    console.warn(`building tileset could not be loaded: ${e.message}`);
                    setTimeout(() => this.root_state = "none", retry_ms);
                });
            }
            const wanted = [];
            const sse_factor = screen_h / (2 * Math.tan(fov_rad / 2));
            const visit = (node) => {
                const dx = Math.max(node.rect[0] - cam_x, 0, cam_x - node.rect[2]) * m_per_uv;
                const dy = Math.max(node.rect[1] - cam_y, 0, cam_y - node.rect[3]) * m_per_uv;
                const dz = Math.max(node.h[0] - cam_h_m, 0, cam_h_m - node.h[1]);
                const d = Math.max(Math.hypot(dx, dy, dz), 1);
                if (node.external) {
                    if (node.state == "none" || (node.state == "failed" && now - node.fail_time > retry_ms))
                        this.load_external(node);
                    if (node.state != "ready")
                        return;
                }
                if (node.content) {
                    node.dist = d;
                    wanted.push(node);
                }
                if (node.ge * sse_factor / d > max_sse_px)
                    for (const child of node.children)
                        visit(child);
            };
            if (this.root)
                for (const child of this.root.children)    // the root has no content
                    visit(child);
            wanted.sort((a, b) => a.dist - b.dist);
            this.wanted = wanted;
            for (const node of wanted) {
                node.last_use = now;
                if (this.loading >= max_loading)
                    break;
                if (node.state == "none" || (node.state == "failed" && now - node.fail_time > retry_ms)) {
                    node.state = "loading";
                    const id = this.next_id++;
                    this.requests.set(id, node);
                    ++this.loading;
                    this.worker.postMessage({id, url: node.content});
                }
            }
            // least recently wanted tiles leave the gpu
            if (this.tiles.size > max_tiles) {
                const old = [...this.tiles].filter(t => t.last_use < now).sort((a, b) => a.last_use - b.last_use);
                for (const t of old.slice(0, this.tiles.size - max_tiles))
                    this.release(t);
            }
        },
        on_tile: function (data) {
            const node = this.requests.get(data.id);
            this.requests.delete(data.id);
            --this.loading;
            if (!node)
                return;
            if (data.error) {
                console.warn(`buildings ${node.content} could not be loaded: ${data.error}`);
                node.state = "failed";
                node.fail_time = performance.now();
            } else {
                const gl = this.gl;
                node.count = data.vertices.length / floats;
                node.origin = data.origin;
                node.grounds = data.grounds;
                if (node.count) {
                    node.buffer = gl.createBuffer();
                    node.vao = gl.createVertexArray();
                    gl.bindVertexArray(node.vao);
                    gl.bindBuffer(gl.ARRAY_BUFFER, node.buffer);
                    gl.bufferData(gl.ARRAY_BUFFER, data.vertices, gl.STATIC_DRAW);
                    for (const [a, size, offset] of [[0, 3, 0], [1, 4, 3], [2, 3, 7]]) {
                        gl.enableVertexAttribArray(a);
                        gl.vertexAttribPointer(a, size, gl.FLOAT, false, floats * 4, offset * 4);
                    }
                    gl.bindVertexArray(null);
                    gl.bindBuffer(gl.ARRAY_BUFFER, null);
                }
                node.state = "ready";
                node.fade = 0;
                this.tiles.add(node);
            }
            if (this.on_change)
                this.on_change();
        },
        release: function (node) {
            if (node.buffer) {
                this.gl.deleteBuffer(node.buffer);
                this.gl.deleteVertexArray(node.vao);
            }
            node.buffer = node.vao = null;
            node.state = "none";
            node.fade = 0;
            this.tiles.delete(node);
        },
        /**
         * @brief the heights of the tileset differ a bit from our terrain, the offset is the median of our terrain minus the
         * ground of the buildings. Needed for the objects which keep their own height (bridges)
         */
        update_height_offset: function (nodes) {
            this.offset_time = performance.now();
            const d = [];
            for (const node of nodes) {
                const g = node.grounds, n = g.length / 3;
                for (let i = 0; i < n; i += Math.max(Math.floor(n / offset_samples), 1)) {
                    const t = this.terrain_height(node.origin[0] + g[3 * i], node.origin[1] + g[3 * i + 1]);
                    if (t !== null)
                        d.push(t - g[3 * i + 2]);
                }
            }
            if (d.length < 8)
                return;
            d.sort((a, b) => a - b);
            this.height_offset = d[d.length >> 1];
        },
        /** @param {Object} p as for VectorRenderer.draw_lines, virtual_street_map */
        draw: function (p) {
            const gl = this.gl;
            const now = performance.now();
            const dt = this.last_draw ? Math.min(now - this.last_draw, 100) : 0;
            this.last_draw = now;
            const wanted = new Set(this.wanted);
            let fading = false;
            const drawn = [];
            for (const node of this.tiles) {
                node.fade = wanted.has(node) ? Math.min(node.fade + dt / fade_ms, 1) : Math.max(node.fade - dt / fade_ms, 0);
                fading |= node.fade > 0 && node.fade < 1;
                if (node.fade > 0 && node.count)
                    drawn.push(node);
            }
            if (fading && this.on_change)
                this.on_change();
            if (!drawn.length)
                return;
            if (now - this.offset_time > offset_interval_ms)
                this.update_height_offset(drawn);
            const u = this.u;
            gl.useProgram(this.program);
            p.virtual_height_map.bind_to_shader(gl.TEXTURE0, gl.TEXTURE1, u.heightmap_infos);
            gl.uniform1i(u.virtual_heightmap_index, 0);
            gl.uniform1i(u.virtual_heightmap, 1);
            gl.uniformBlockBinding(this.program, u.heightmap_infos, u.heightmap_infos);
            p.virtual_street_map.bind_to_shader(gl.TEXTURE2, gl.TEXTURE3, u.streetmap_infos);
            gl.uniform1i(u.virtual_streetmap_index, 2);
            gl.uniform1i(u.virtual_streetmap, 3);
            gl.uniformBlockBinding(this.program, u.streetmap_infos, u.streetmap_infos);
            gl.uniformMatrix4fv(u.view_proj, false, p.view_proj);
            gl.uniform2f(u.grid_offset_pos, p.grid_offset_pos.x, p.grid_offset_pos.y);
            gl.uniform3f(u.cam_pos, p.cam_pos[0], p.cam_pos[1], p.cam_pos[2]);
            gl.uniform1f(u.lod_factor, p.lod_factor);
            gl.uniform1i(u.max_mesh_level, p.max_mesh_level);
            gl.uniform1f(u.height_offset, this.height_offset);
            gl.enable(gl.DEPTH_TEST);
            gl.depthFunc(gl.LESS);
            gl.depthMask(true);
            gl.disable(gl.BLEND);
            gl.disable(gl.CULL_FACE);
            for (const node of drawn) {
                gl.uniform2f(u.tile_origin, node.origin[0] - p.grid_offset_pos.x, node.origin[1] - p.grid_offset_pos.y);
                gl.uniform1f(u.fade, node.fade);
                gl.bindVertexArray(node.vao);
                gl.drawArrays(gl.TRIANGLES, 0, node.count);
            }
            gl.bindVertexArray(null);
        },
    };
};
