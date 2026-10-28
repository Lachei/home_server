// 3d buildings (LoD2) of the Bayerische Vermessungsverwaltung (geodaten.bayern.de, data of the BayernAtlas 3d view).
// The buildings are a 3d tiles tileset of b3dm tiles (glTF 1.0 with CESIUM_RTC) in a geographic quadtree, refined by
// adding buildings (refine ADD): the finer levels have the smaller buildings and are loaded closer to the camera.
// The tiles are parsed in a worker into vertices on our map (uv and height), the buildings are placed at the position
// of the tileset. Roofs show the map below them (the aerial image shows the roofs), walls are light grey.
// Has to be loaded after virtual_texture.js

/**
 * @brief code running in the worker, it is converted to a string, so it must not use anything from outside
 */
const bayern_3d_worker_main = () => {
    const text_decoder = new TextDecoder();

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
     * @returns {{gltf, body: Uint8Array}}
     */
    const parse_b3dm = (buf) => {
        const dv = new DataView(buf);
        if (dv.getUint32(0, true) != 0x6d643362)    // "b3dm"
            throw new Error("no b3dm tile");
        const legacy = 570425344;
        const [f3, f4, f5, f6] = [3, 4, 5, 6].map(i => dv.getUint32(4 * i, true));
        const o = f5 >= legacy ? 20 + f4 : f6 >= legacy ? 24 + f3 + f4 : 28 + f3 + f4 + f5 + f6;
        const glb = new DataView(buf, o);
        if (glb.getUint32(0, true) != 0x46546c67)   // "glTF"
            throw new Error("no binary glTF in the b3dm tile");
        if (glb.getUint32(4, true) != 1)
            throw new Error("only glTF 1.0 is supported");
        const json_length = glb.getUint32(12, true);
        const gltf = JSON.parse(text_decoder.decode(new Uint8Array(buf, o + 20, json_length)));
        return {gltf, body: new Uint8Array(buf, o + 20 + json_length)};
    };

    /**
     * @returns {{vertices: Float32Array, origin: [x, y]}} triangles of the walls and roofs (the ground surfaces are left
     * out), per vertex x, y (uv relative to origin), height above the sea (m), normal east, south, up
     */
    const build_tile = (buf) => {
        const {gltf, body} = parse_b3dm(buf);
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
        let origin = null;
        const out = [];
        for (const {prim, m} of prims) {
            if ((prim.mode ?? 4) != 4)
                continue;
            const pos = read_accessor(gltf, body, prim.attributes.POSITION);
            const nor = prim.attributes.NORMAL ? read_accessor(gltf, body, prim.attributes.NORMAL) : null;
            const idx = prim.indices ? read_accessor(gltf, body, prim.indices) : null;
            const count = idx ? idx.length : pos.length / 3;
            let tri = [];
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
                const [x, y] = uv_of(lon, lat);
                origin = origin || [x, y];
                tri.push(x - origin[0], y - origin[1], h, ne, -nn, nu);
                if (tri.length < 18)
                    continue;
                // ground surfaces (normal down) are below the terrain anyway
                if (!(tri[5] < -.5 && tri[11] < -.5 && tri[17] < -.5))
                    out.push(...tri);
                tri = [];
            }
        }
        return {vertices: new Float32Array(out), origin: origin || [0, 0]};
    };

    self.onmessage = async (e) => {
        const {id, url} = e.data;
        try {
            const r = await fetch(url);
            if (!r.ok)
                throw new Error(`${r.status}`);
            const {vertices, origin} = build_tile(await r.arrayBuffer());
            self.postMessage({id, vertices, origin}, [vertices.buffer]);
        } catch (err) {
            self.postMessage({id, error: String(err.message || err)});
        }
    };
};

/**
 * @brief traverses the tileset of the buildings (tileset files are loaded when reached), loads the tiles close enough
 * to the camera (screen space error of their parent too large) and draws them at their position. Tiles fade in and out
 * (dithered, no sorting needed)
 */
const BuildingRenderer = () => {
    const tileset_url = "https://bvv3d22.bayernwolke.de/3d-data/latest/lod23d/tileset.json";
    const max_sse_px = 24;          // children are shown if the geometric error of their parent is larger on the screen
    const max_loading = 6;
    const max_tiles = 400;          // tiles kept on the gpu
    const fade_ms = 500;
    const retry_ms = 30000;
    const floats = 6;
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

        init: function (gl, virtual_street_map) {
            this.gl = gl;
            this.create_program(virtual_street_map);
            this.worker = new Worker(URL.createObjectURL(new Blob([`(${bayern_3d_worker_main.toString()})()`], {type: "text/javascript"})));
            this.worker.onmessage = (e) => this.on_tile(e.data);
            return this;
        },
        /** @brief (re)creates the shader program, needed again if a setting compiled into the shaders changes (seamless_tiles) */
        create_program: function (virtual_street_map) {
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
            uniform mat4 view_proj;
            uniform vec2 tile_origin;           // relative to grid_offset_pos
            uniform float fade;
            ${Util.glsl_virtual_texture_uniforms("streetmap", virtual_street_map)}
            ${Util.glsl_virtual_texture_load("streetmap")}
            ${Util.glsl_wgs_84_m_to_uv()}
            `;
            const vs = header + `
            layout(location = 0) in vec3 pos;       // uv relative to the tile origin, height above the sea in meters
            layout(location = 1) in vec3 normal;    // east, south, up
            out vec3 v_normal;
            out vec2 v_pos;
            void main() {
                vec3 p = vec3(tile_origin + pos.xy, wgs_84_m_to_uv(pos.z) * 1.4);
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
                // fading by dithering (4x4 bayer matrix), the buildings need no sorting. Computed from the 2x2 matrix instead
                // of a constant array, mobile chrome fails to compile dynamically indexed constant arrays
                ivec2 q = ivec2(gl_FragCoord.xy) & 3;
                ivec2 lo = q & 1, hi = q >> 1;
                int bayer = 4 * (2 * (lo.x ^ lo.y) + lo.y) + 2 * (hi.x ^ hi.y) + hi.y;
                if (fade < 1. && (float(bayer) + .5) / 16. > fade)
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
            for (const name of ["grid_offset_pos", "view_proj", "tile_origin", "fade", "virtual_streetmap_index", "virtual_streetmap"])
                u[name] = gl.getUniformLocation(this.program, name);
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
                if (node.count) {
                    node.buffer = gl.createBuffer();
                    node.vao = gl.createVertexArray();
                    gl.bindVertexArray(node.vao);
                    gl.bindBuffer(gl.ARRAY_BUFFER, node.buffer);
                    gl.bufferData(gl.ARRAY_BUFFER, data.vertices, gl.STATIC_DRAW);
                    for (const [a, offset] of [[0, 0], [1, 3]]) {
                        gl.enableVertexAttribArray(a);
                        gl.vertexAttribPointer(a, 3, gl.FLOAT, false, floats * 4, offset * 4);
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
            const u = this.u;
            gl.useProgram(this.program);
            p.virtual_street_map.bind_to_shader(gl.TEXTURE0, gl.TEXTURE1, u.streetmap_infos);
            gl.uniform1i(u.virtual_streetmap_index, 0);
            gl.uniform1i(u.virtual_streetmap, 1);
            gl.uniformBlockBinding(this.program, u.streetmap_infos, u.streetmap_infos);
            gl.uniformMatrix4fv(u.view_proj, false, p.view_proj);
            gl.uniform2f(u.grid_offset_pos, p.grid_offset_pos.x, p.grid_offset_pos.y);
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
