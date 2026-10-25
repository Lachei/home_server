/**
 * @brief Virtualized textures for heightmap loading and texture maps loading
 * 
 * This file contains constructors and functions for a virtual heightmap as well as
 * a virtual global textures (satellite as well as street view)
 * 
 * Basically there is a detail region over the region of bavaria, while the rest of the
 * world is filled automatically by open source map data
 * This is done to get a seamless transition between high quality local data and global
 * coverage of the whole world
 * 
 * The virtual textures themselves work by providing textures in the background, the texture tiles with map data,
 * and filling a large virtual texture which contains the an index into the texture tiles for readout.
 * For heightmaps an additional texture is provided to also support offset and rescaling for more efficient height storage.
 *
 * The update of the virtual textures is done by simply providing a list of required tiles (list of tile indices, tile index consisting of lat, lon, pyramid depth)
 * and then issues async loading threads which, upon completion write into the texture into the tiles buffer and
 * update the virtual texture to contain the indices of the tile
 * 
 * All the dimensions and such are hardcoded, as this code is not meant to be easily adopted to any other map type
 * The code overall is very specific to this kind of map and does not easily generalize
 * 
 * In the following row always stands for Rest Of World
 */

// type declarations
const virtual_map_type = 0x12392445;
const satellite_map_type = 0x12392446;
const streetview_map_type = 0x12392447;
const tiles_gpu_type = 0x12392448;
const tile_type = 0x12392449;
const tile_request_type = 0x12392450;
const texture_type_type = 0x12392451;
const map_provider_type = 0x12392452;

// const declarations for settings
const max_loading_tiles = 32;           // max tiles per virtual map which are downloaded at the same time
// downloads used for preloading, the remaining slots are kept free for tiles which become visible
const max_preloading_tiles = 16;
// preloaded tiles only replace tiles which were not used for this time
const preload_keep_ms = 10000;
// downloads which neither finished nor failed after this time are treated as failed. Some browsers (e.g. chrome mobile)
// stall requests without an error, the stuck tiles would otherwise block all loading slots forever
const tile_load_timeout_ms = 15000;
// decode() does not always resolve (e.g. chrome mobile under memory pressure), the image is then used undecoded
const tile_decode_timeout_ms = 2000;
const coarse_level_priority_ms = 1000.;   // a tile one level coarser is kept like a tile which was used this much more recently
// urls which could not be loaded are retried with exponential backoff. Failures are often not permanent
// (e.g. the browser cancels requests when too many tiles are requested at once), so the first retries are quick
const failed_url_retry_base_ms = 500;
const failed_url_retry_max_ms = 60000;
// The index of a virtual map is split into cascades: cascade 0 covers the whole world, every further cascade covers a
// window around the camera with a higher resolution. Each cascade has its own tile storage (indexed by 8 bit) and index texture
const default_cascade_count = 3;
const cascade_index_res_log2 = 11;      // index textures of all cascades have 2048 x 2048 texels

const VirtualMap = () => {
    return {
        type: virtual_map_type,
        // member variables
        tile_width: 0,
        tile_height: 0,
        max_tiles: 0,           // max tiles per cascade
        max_level: 0,           // deepest tile level, log2(v_tex_width)
        v_tex_height: 0,
        v_tex_width: 0,
        /**
         * cascade c stores the tiles with level in [min_level, min_level of cascade c + 1), its index texture has one texel
         * per tile of texel_level and covers a window starting at offset (in uv)
         * @type {Array.<{texel_level: int, min_level: int, offset: {x: float, y: float}, tiles: Array.<Tile>, lookup_table: Object.<string, int>, free_tiles: Set.<int>, framebuffer: WebGLFramebuffer}>}
         */
        cascades: [],
        /** @type {TilesGpu} */
        tiles_storage_gpu: null,
        /** @type {WebGL2Buffer} */
        tiles_infos_buffer: null,
        virtual_texture_rebuilt: false, // used to determine whether view has to be rerendered due to an updated virtual texture cache
        /** @type {WebGLTexture} R8UI texture array with one layer per cascade, contains the tile index + 1, 0 for no tile */
        index_texture_gpu: null,
        virtual_texture_render_pipeline: null,
        /** @type {WebGL2RenderingContext} */
        gl_context: null,
        image_canvas_context: null,
        /** @type {function(Tile, Uint8Array):void} optional callback receiving the cpu pixel data of each tile on gpu upload */
        tile_data_callback: null,
        /** @type {Map.<string, {count: int, time: int}>} urls which could not be loaded with the amount of consecutive failures and the time of the last failure */
        failed_urls: new Map(),

        // functions
        /**
         * @param {int} v_tex_width The amount of tiles at highest precision available (has to be a power of 2)
         * @param {int} v_tex_height The amount of tiles at highest precision available (has to be equal to v_tex_width)
         * @param {{x: float, y:float}} initial_detail_center The center of the cascade windows on instantiation in 0-1 normalized uv
         * @param {int} tile_width The width of a single tile (no matter which detail level, all have to be the same size) in pixels
         * @param {int} tile_height The height of a single tile (no matter which detail level, all ahv eto be the same size) in pixels
         * @param {int} max_tiles The maximum amount of tiles stored per cascade (at most 255 as the index textures have 8 bit)
         * @param {WebGL2RenderingContext} gl_context 
         * @param {int} cascade_count Amount of index cascades
         */
        init: function (v_tex_width, v_tex_height, initial_detail_center, tile_width, tile_height, max_tiles, texture_type, gl_context, cascade_count = default_cascade_count) {
            if (max_tiles > 255) {
                console.error("max_tiles has to be at most 255 as the index textures are 8 bit");
                max_tiles = 255;
            }
            this.tile_width = tile_width;
            this.tile_height = tile_height;
            this.max_tiles = max_tiles;
            this.v_tex_width = v_tex_width;
            this.v_tex_height = v_tex_height;
            this.max_level = Math.log2(v_tex_width);
            // cascade 0 covers the whole world, the texel levels of the other cascades are distributed evenly up to max_level
            const base_level = Math.min(cascade_index_res_log2, this.max_level);
            this.cascades = [];
            for (let c = 0; c < cascade_count; ++c) {
                this.cascades.push({
                    texel_level: c == 0 ? base_level : base_level + Math.round(c * (this.max_level - base_level) / (cascade_count - 1)),
                    min_level: c == 0 ? 0 : this.cascades[c - 1].texel_level,
                    offset: {x: 0, y: 0},
                    tiles: Array.from({length: max_tiles}, () => Tile()),
                    lookup_table: {},
                    free_tiles: new Set(Array.from({length: max_tiles}, (_, i) => i)),
                    framebuffer: null,
                });
            }
            this.tiles_storage_gpu = TilesGpu().init(tile_width, tile_height, max_tiles * cascade_count, gl_context, texture_type);
            this.tiles_infos_buffer = gl_context.createBuffer();
            gl_context.bindBuffer(gl_context.UNIFORM_BUFFER, this.tiles_infos_buffer);
            gl_context.bufferData(gl_context.UNIFORM_BUFFER, this.infos_buffer_byte_size(), gl_context.DYNAMIC_DRAW);
            gl_context.bindBuffer(gl_context.UNIFORM_BUFFER, null);
            const index_res = 1 << cascade_index_res_log2;
            this.index_texture_gpu = gl_context.createTexture();
            gl_context.bindTexture(gl_context.TEXTURE_2D_ARRAY, this.index_texture_gpu);
            gl_context.texStorage3D(gl_context.TEXTURE_2D_ARRAY, 1, gl_context.R8UI, index_res, index_res, cascade_count);
            gl_context.texParameteri(gl_context.TEXTURE_2D_ARRAY, gl_context.TEXTURE_MIN_FILTER, gl_context.NEAREST);
            gl_context.texParameteri(gl_context.TEXTURE_2D_ARRAY, gl_context.TEXTURE_MAG_FILTER, gl_context.NEAREST);
            for (let c = 0; c < cascade_count; ++c) {
                this.cascades[c].framebuffer = gl_context.createFramebuffer();
                gl_context.bindFramebuffer(gl_context.FRAMEBUFFER, this.cascades[c].framebuffer);
                gl_context.framebufferTextureLayer(gl_context.FRAMEBUFFER, gl_context.COLOR_ATTACHMENT0, this.index_texture_gpu, 0, c);
            }
            const pipeline = initShaderProgram(gl_context,
                    /** Vertex Shader */
                    `#version 300 es
                    uniform ivec4 bounds; // contains in xy the min and max x, and in zw min and max y
                    uniform ivec2 image_size;
                    void main() {
                      int x = bool(gl_VertexID & 1) ? bounds.y: bounds.x;
                      int y = gl_VertexID == 2 || gl_VertexID == 4 || gl_VertexID == 5 ? bounds.w : bounds.z;
                      gl_Position = vec4(float(x) / float(image_size.x) * 2. - 1.,
                                         float(y) / float(image_size.y) * 2. - 1.,
                                         .5, 1.);
                    }
                    `,
                    /** fragment shader */
                    `#version 300 es
                    uniform uint index;
                    out uint buf_ind;
                    void main() {buf_ind = index;}`)
            this.virtual_texture_render_pipeline = {
                program: pipeline,
                uniforms: {
                    bounds: gl_context.getUniformLocation(pipeline, "bounds"),
                    image_size: gl_context.getUniformLocation(pipeline, "image_size"),
                    index: gl_context.getUniformLocation(pipeline, "index"),
                }
            };
            this.gl_context = gl_context;
            this.image_canvas_context = Util.create_canvas_context(tile_width, tile_height);
            this.update_cascade_windows(initial_detail_center);
            this.rebuild_virtual_texture();
            return this;
        },
        /** @returns {int} byte size of the infos uniform buffer, one vec4 per cascade followed by one ivec4 per tile */
        infos_buffer_byte_size: function () {
            return (this.cascades.length + this.cascades.length * this.max_tiles) * 4 * 4;
        },
        /** @returns {int} the cascade storing tiles of the given level */
        cascade_of_level: function (level) {
            let c = this.cascades.length - 1;
            while (c > 0 && this.cascades[c].min_level > level)
                --c;
            return c;
        },
        /** @returns {bool} true if the tile (given in tiles of max_level) lies completely inside the window of cascade c */
        tile_in_window: function (c, tile_x, tile_y, width) {
            if (c == 0)
                return true;
            const cascade = this.cascades[c];
            const x = tile_x - cascade.offset.x * this.v_tex_width;
            const y = tile_y - cascade.offset.y * this.v_tex_height;
            const size = (1 << cascade_index_res_log2) * 2 ** (this.max_level - cascade.texel_level);
            return x >= 0 && y >= 0 && x + width <= size && y + width <= size;
        },
        /**
         * @brief centers the windows of the cascades around the given uv position, drops tiles which are outside of the new windows
         * @returns {bool} true if any window moved
         */
        update_cascade_windows: function (center_uv) {
            let changed = false;
            for (let c = 1; c < this.cascades.length; ++c) {
                let cascade = this.cascades[c];
                // the window is aligned to the tiles of min_level such that every tile of the cascade is either completely inside or outside
                const n = 2 ** cascade.min_level;
                const window_tiles = (1 << cascade_index_res_log2) / 2 ** (cascade.texel_level - cascade.min_level);
                const x = Math.floor(center_uv.x * n - window_tiles / 2) / n;
                const y = Math.floor(center_uv.y * n - window_tiles / 2) / n;
                if (x == cascade.offset.x && y == cascade.offset.y)
                    continue;
                cascade.offset = {x: x, y: y};
                changed = true;
                for (let i = 0; i < cascade.tiles.length; ++i) {
                    const tile = cascade.tiles[i];
                    if (tile.is_initialized() && !this.tile_in_window(c, tile.tile_x, tile.tile_y, tile.width))
                        this.drop_tile_at_index(i, c);
                }
            }
            return changed;
        },
        /**
         * @brief validates the request and computes where the tile is stored
         * @returns {Object} null if the tile can not be stored or its url failed recently, otherwise
         *          {url, c, final_x, final_y, width, lookup_table_string, stored: bool, dropped: bool}. dropped is set if a
         *          stored tile with different urls was dropped, the virtual texture has to be rebuilt then
         */
        resolve_request: function (tile_req) {
            if (tile_req.type != tile_request_type) {// ignore wrong type tiles
                console.error("Wrong type for tile request, got type: " + String(tile_req.type));
                return null;
            }
            if (tile_req.level > this.max_level) {
                console.error("Too deep level for this virtual texture. Ignoring");
                return null;
            }
            const width = 2 ** (this.max_level - tile_req.level);
            const final_x = (tile_req.x * width + Math.floor(tile_req.offsets.x * this.v_tex_width)) % this.v_tex_width;
            const final_y = (tile_req.y * width + Math.floor(tile_req.offsets.y * this.v_tex_height)) % this.v_tex_height;
            if (final_x + width > this.v_tex_width || final_y + width > this.v_tex_height) {
                console.error("VirtualTexture::update_needed_tiles() new tile invalid x/y");
                return null;
            }
            const c = this.cascade_of_level(tile_req.level);
            if (!this.tile_in_window(c, final_x, final_y, width))   // can not be stored, coarser tiles are used there
                return null;
            const failed = this.failed_urls.get(String(tile_req.url));
            if (failed !== undefined && Date.now() - failed.time < Math.min(failed_url_retry_base_ms * 2 ** (failed.count - 1), failed_url_retry_max_ms))
                return null;
            let cascade = this.cascades[c];
            const lookup_table_string = CoordinateMappings.coords_to_lookup_string(final_x, final_y, width);
            let stored = lookup_table_string in cascade.lookup_table;
            let dropped = false;
            if (stored && Array.isArray(cascade.tiles[cascade.lookup_table[lookup_table_string]].url)) {
                const tile = cascade.tiles[cascade.lookup_table[lookup_table_string]];
                if (!Array.isArray(tile_req.url) || tile.url.length != tile_req.url.length || tile.url.some((url, i) => url != tile_req.url[i])) {
                    this.drop_tile_at_index(cascade.lookup_table[lookup_table_string], c);
                    stored = false;
                    dropped = true;
                }
            }
            return {url: tile_req.url, c: c, final_x: final_x, final_y: final_y, width: width, lookup_table_string: lookup_table_string, stored: stored, dropped: dropped};
        },
        /** 
         * @param {Array.<TileRequest>} tile_requests Tiles which are needed next frame 
         * @param {{x: float, y: float}} cam_center_uv Camera center the cascade windows are centered around
         * @param {Array.<TileRequest>} preload_requests Tiles which might be needed soon (e.g. neighbors of the visible tiles).
         *        They are only loaded with spare download slots and never replace tiles which were used recently
         */
        update_needed_tiles: function (tile_requests, cam_center_uv, preload_requests = []) {
            // sorting the tile requests to have the highest detailed images last, if a cascade is full the
            // coarser tiles get the free slots as they are the fallback for the detailed ones
            tile_requests.sort((a, b) => a.level - b.level);
            const request_time = Date.now();
            let rebuild_vtex_needed = this.update_cascade_windows(cam_center_uv);

            // first all requested tiles which are already stored are marked as used, otherwise making space for a new
            // tile could drop a stored tile which is requested later in this update and has to be loaded again
            let needed = [];
            for (const tile_req of tile_requests) {
                const r = this.resolve_request(tile_req);
                if (!r)
                    continue;
                rebuild_vtex_needed |= r.dropped;
                if (r.stored)
                    this.cascades[r.c].tiles[this.cascades[r.c].lookup_table[r.lookup_table_string]].last_use = request_time;
                else
                    needed.push(r);
            }

            // limiting the running downloads: while the camera moves, most tiles requested at once would not be needed
            // anymore when their download finished and would be canceled, which is expensive in the browser
            let loading = 0;
            for (let c = 0; c < this.cascades.length; ++c) {
                const tiles = this.cascades[c].tiles;
                for (let i = 0; i < tiles.length; ++i) {
                    const tile = tiles[i];
                    if (!tile.is_initialized() || tile.data_uploaded_to_gpu)
                        continue;
                    if (request_time - tile.load_start > tile_load_timeout_ms) {
                        const failed = this.failed_urls.get(String(tile.url));
                        this.failed_urls.set(String(tile.url), {count: failed ? failed.count + 1 : 1, time: request_time});
                        this.drop_tile_at_index(i, c);
                        continue;
                    }
                    ++loading;
                }
            }
            const load = (n, keep_since, max_loading) => {
                if (loading >= max_loading)
                    return false;
                let cascade = this.cascades[n.c];
                if (n.lookup_table_string in cascade.lookup_table)  // requested twice
                    return true;
                // make space for a new tile if tile cache full
                if (cascade.free_tiles.size == 0) {
                    this.drop_least_important_tiles(10, n.c, keep_since);
                    rebuild_vtex_needed = true;
                }
                // all tiles of the cascade are needed by this request, the coarser tiles are used instead
                // (requests are sorted coarse to fine). Dropping needed tiles would reload them forever
                if (cascade.free_tiles.size == 0)
                    return true;
                const [i_cpu] = cascade.free_tiles;
                cascade.free_tiles.delete(i_cpu);
                let t = cascade.tiles[i_cpu];
                t.reset();
                t.init(n.url, n.final_x, n.final_y, n.width, n.c);
                t.last_use = request_time;
                cascade.lookup_table[n.lookup_table_string] = i_cpu;
                ++loading;
                return true;
            };
            for (const n of needed)
                if (!load(n, request_time, max_loading_tiles))
                    break;

            // preloading after the needed tiles, so that preloaded tiles of earlier updates can be replaced by needed ones
            preload_requests.sort((a, b) => a.level - b.level);
            for (const tile_req of preload_requests) {
                const r = this.resolve_request(tile_req);
                if (!r)
                    continue;
                rebuild_vtex_needed |= r.dropped;
                if (r.stored)
                    this.cascades[r.c].tiles[this.cascades[r.c].lookup_table[r.lookup_table_string]].last_use = request_time;
                else if (!load(r, request_time - preload_keep_ms, max_preloading_tiles))
                    break;
            }
            if (rebuild_vtex_needed)
                this.rebuild_virtual_texture();
        },
        /** @returns {int} global index (over all cascades) of the loaded parent of the tile, -1 if not loaded */
        parent_index: function (tile) {
            if (!tile.is_initialized() || tile.width >= this.v_tex_width)
                return -1;
            const parent_width = tile.width * 2;
            const parent_c = this.cascade_of_level(this.max_level - Math.log2(parent_width));
            const parent_x = Math.floor(tile.tile_x / parent_width) * parent_width;
            const parent_y = Math.floor(tile.tile_y / parent_width) * parent_width;
            const i = this.cascades[parent_c].lookup_table[CoordinateMappings.coords_to_lookup_string(parent_x, parent_y, parent_width)];
            if (i === undefined || !this.cascades[parent_c].tiles[i].data_uploaded_to_gpu)
                return -1;
            return parent_c * this.max_tiles + i;
        },
        /** @brief updates the virtual texture to contain the correct textures stored in the virtual texture cache */
        rebuild_virtual_texture: function () {
            // filling the index textures, coarse tiles are drawn first and are overwritten by finer tiles
            const gl = this.gl_context;
            const index_res = 1 << cascade_index_res_log2;
            gl.viewport(0, 0, index_res, index_res);
            gl.disable(gl.DEPTH_TEST);
            gl.disable(gl.CULL_FACE);
            gl.useProgram(this.virtual_texture_render_pipeline.program);
            gl.uniform2i(this.virtual_texture_render_pipeline.uniforms.image_size, index_res, index_res);
            for (const cascade of this.cascades) {
                gl.bindFramebuffer(gl.FRAMEBUFFER, cascade.framebuffer);
                // clear the whole image
                gl.uniform4i(this.virtual_texture_render_pipeline.uniforms.bounds, 0, index_res, 0, index_res);
                gl.uniform1ui(this.virtual_texture_render_pipeline.uniforms.index, 0);
                gl.drawArrays(gl.TRIANGLES, 0, 6);

                const s = 2 ** (cascade.texel_level - this.max_level);    // index texels per tile of max_level
                const off_x = cascade.offset.x * 2 ** cascade.texel_level;
                const off_y = cascade.offset.y * 2 ** cascade.texel_level;
                const ordered_tiles = cascade.tiles.map((x, i) => [x.width, i]).sort((a, b) => b[0] - a[0]);
                for (const [width, idx] of ordered_tiles) {
                    const tile = cascade.tiles[idx];
                    if (!tile.is_initialized() || !tile.data_uploaded_to_gpu) // ignore not uploaded tiles (will be updated later due to callback which calls this function in its final steps)
                        continue;
                    gl.uniform4i(this.virtual_texture_render_pipeline.uniforms.bounds, tile.tile_x * s - off_x, (tile.tile_x + tile.width) * s - off_x, 
                                                                                        tile.tile_y * s - off_y, (tile.tile_y + tile.width) * s - off_y);
                    gl.uniform1ui(this.virtual_texture_render_pipeline.uniforms.index, idx + 1);
                    gl.drawArrays(gl.TRIANGLES, 0, 6);
                }
            }

            // filling tiles_info_buffer_gpu with the cascade and tile infos
            let buffer = new ArrayBuffer(this.infos_buffer_byte_size());
            let cascade_infos = new Float32Array(buffer, 0, this.cascades.length * 4);
            let tiles_info = new Int32Array(buffer, this.cascades.length * 4 * 4);
            this.cascades.forEach((cascade, c) => {
                cascade_infos.set([cascade.offset.x, cascade.offset.y, 2 ** cascade.texel_level, this.max_level], c * 4);
                cascade.tiles.forEach((tile, i) => {
                    tiles_info.set([tile.tile_x, tile.tile_y, tile.width, this.parent_index(tile)], (c * this.max_tiles + i) * 4);
                });
            });
            gl.bindBuffer(gl.UNIFORM_BUFFER, this.tiles_infos_buffer);
            gl.bufferData(gl.UNIFORM_BUFFER, buffer, gl.DYNAMIC_DRAW);
            gl.bindBuffer(gl.UNIFORM_BUFFER, null);

            // signal updated virtual texture
            this.virtual_texture_rebuilt = true;
        },
        bind_to_shader: function (gl_texture_slot_index, gl_texture_slot_texture, gl_infos_uniform) {
            const gl = this.gl_context;
            gl.activeTexture(gl_texture_slot_index);
            gl.bindTexture(gl.TEXTURE_2D_ARRAY, this.index_texture_gpu);
            gl.bindBufferBase(gl.UNIFORM_BUFFER, gl_infos_uniform, this.tiles_infos_buffer);
            this.tiles_storage_gpu.bind_to_shader(gl_texture_slot_texture);
        },
        /** @param {int} i Index of the element to drop in cascade c, only removes from the cpu side */
        drop_tile_at_index: function (i, c) {
            let cascade = this.cascades[c];
            if (!cascade.tiles[i]) {
                console.error("Tile to drop does not exist")
                return;
            }
            let lookup_table_string = cascade.tiles[i].lookup_table_string;
            if (cascade.lookup_table[lookup_table_string] != i)
                console.error(`Index mismatch for delete: Found index ${cascade.lookup_table[lookup_table_string]}`);
            cascade.tiles[i].reset();
            delete cascade.lookup_table[lookup_table_string];
            cascade.free_tiles.add(i);
        },
        /**
         * @param {int} n Number of tiles to drop from cascade c, all tiles of the cascade if n is not given
         * @param {int} keep_since Tiles used at or after this time are not dropped
         */
        drop_least_important_tiles: function (n, c, keep_since = Infinity) {
            const tiles = this.cascades[c].tiles;
            if (!n) {
                for (let i = tiles.length - 1; i >= 0; --i)
                    if (tiles[i].is_initialized())
                        this.drop_tile_at_index(i, c);
            } else {
                // gets for each tile in the cpu cache the priority and sorts it in ascending order
                let sorted_prios = tiles.map((x, i) => [x.get_priority(), i]).filter(([, i]) => tiles[i].last_use < keep_since).sort((a, b) => a[0] - b[0]);
                for (let i = 0; i < n && i < sorted_prios.length; ++i)
                    if (tiles[sorted_prios[i][1]].is_initialized())
                        this.drop_tile_at_index(sorted_prios[i][1], c);    // get the i-th least important tile and retrieve the index from it
            }
            return this;
        },
        drop_all_tiles: function () {
            for (let c = 0; c < this.cascades.length; ++c)
                this.drop_least_important_tiles(null, c);
            this.rebuild_virtual_texture();
            return this;
        },
        /** @returns {Tile} the tile at the given pyramid level and tile coordinates if its data is on the gpu, null otherwise */
        get_uploaded_tile: function (level, x, y) {
            if (level > this.max_level)
                return null;
            const width = 2 ** (this.max_level - level);
            const cascade = this.cascades[this.cascade_of_level(level)];
            const i = cascade.lookup_table[CoordinateMappings.coords_to_lookup_string(x * width, y * width, width)];
            if (i === undefined)
                return null;
            const tile = cascade.tiles[i];
            return tile.data_uploaded_to_gpu ? tile: null;
        },
        upload_loaded_images: function () {
            const max_upload = 5; // upload at max 5 images per call
            let upload = 0;
            let change = false;
            for (let c = 0; c < this.cascades.length; ++c) {
                const tiles = this.cascades[c].tiles;
                // reverse loop to be able to drop frames without reiteration
                for (let i = tiles.length - 1; i >= 0 && upload < max_upload; --i) {
                    let tile = tiles[i];
                    let all_loaded = tile.loaded;
                    if (Array.isArray(tile.loaded))
                        all_loaded = tile.loaded.every(x => x);
                    if (!all_loaded || tile.data_uploaded_to_gpu || !tile.is_initialized())
                        continue;
                    let any_error = tile.load_error;
                    if (Array.isArray(tile.load_error))
                        any_error = tile.load_error.some(x => x);
                    if (any_error) {
                        const failed = this.failed_urls.get(String(tile.url));
                        this.failed_urls.set(String(tile.url), {count: failed ? failed.count + 1 : 1, time: Date.now()});
                        this.drop_tile_at_index(i, c);
                        change = true;
                        continue;
                    }
                    if (tile.images) {
                        // several images are composed on the canvas
                        this.image_canvas_context.clearRect(0, 0, this.tile_width, this.tile_height);
                        for (let image of tile.images)
                            this.image_canvas_context.drawImage(image, 0, 0);
                        let data = new Uint8Array(this.image_canvas_context.getImageData(0, 0, this.tile_width, this.tile_height).data.buffer);
                        if (this.tile_data_callback)
                            this.tile_data_callback(tile, data);
                        this.tiles_storage_gpu.set_image_data(c * this.max_tiles + i, data);
                    } else {
                        // larger images (e.g. 512 pixel tiles of the parent level) are cut with the url fragment #sub=x,y in image pixels,
                        // the sub image is copied without scaling as encoded data (heights) must not be interpolated
                        const sub = /#sub=(\d+),(\d+)$/.exec(String(tile.url));
                        const sx = sub ? +sub[1] : 0, sy = sub ? +sub[2] : 0;
                        if (!sub && (tile.image.width != this.tile_width || tile.image.height != this.tile_height))
                            console.error(`Image dimension mismatch, loaded image is not of same dimension ${tile.image.width}, ${tile.image.height} needed for this virtual texture`);
                        // uploaded directly instead of via getImageData, browsers with fingerprinting protection (e.g. brave)
                        // add noise to canvas readbacks which results in spikes of up to 256 m in the encoded heights
                        this.tiles_storage_gpu.set_image_source(c * this.max_tiles + i, tile.image, sx, sy);
                        if (this.tile_data_callback) {
                            this.image_canvas_context.clearRect(0, 0, this.tile_width, this.tile_height);
                            this.image_canvas_context.drawImage(tile.image, sx, sy, this.tile_width, this.tile_height, 0, 0, this.tile_width, this.tile_height);
                            this.tile_data_callback(tile, new Uint8Array(this.image_canvas_context.getImageData(0, 0, this.tile_width, this.tile_height).data.buffer));
                        }
                    }
                    tile.data_uploaded_to_gpu = true;
                    this.failed_urls.delete(String(tile.url));
                    change = true;
                    upload += 1;
                }
            }
            if (change)
                this.rebuild_virtual_texture();
        }
    };
};

/**
 * @brief helper object to get different gpu and cpu buffer for different texture types along with
 * the correct formats
 * @param {WebGL2RenderingContext} gl WebGL rendering context
 */
const TextureTypes = (gl) => {
    return {
        ui8r: {
            type: texture_type_type,
            bytes_per_element: 1,
            format: gl.R8UI,
            format_cpu: gl.RED_INTEGER,
            element_type: gl.UNSIGNED_BYTE,
            create_new_cpu_buffer: function (n) { return new Uint8Array(n); },
        },
        ui8rg: {
            type: texture_type_type,
            bytes_per_element: 2,
            format: gl.RG8,
            element_type: gl.UNSIGNED_BYTE,
            create_new_cpu_buffer: function (n) { return new Uint8Array(2 * n); },
        },
        un8rgba: {
            type: texture_type_type,
            bytes_per_element: 4,
            format: gl.RGBA,
            element_type: gl.UNSIGNED_BYTE,
            create_new_cpu_buffer: function (n) { return new Uint8Array(4 * n); },
        },
    };
};
/**
 * @brief Represents the whole tiles storage on the gpu as a webgl texture array
 */
const TilesGpu = () => {
    return {
        type: tiles_gpu_type,
        // member variables
        tile_width: 0,
        tile_height: 0,
        max_size: 0,
        /** @type {{type: int, bytes_per_element: int, format: int, element_type: int}} */
        texture_type: null,
        /** @type {WebGL2RenderingContext} */
        gl_context: null,
        /** @type {WebGLTexture} */
        texture_gpu: null,
        /** @type {ArrayBuffer} */

        // member functions
        /**
         * @param {int} tile_width Tile width in pixels
         * @param {int} tile_height Tile height in pixels
         * @param {int} max_size Max amounts of images (layers of the texture array)
         * @param {WebGL2RenderingContext} gl_context WeTile height in pixels
         */
        init: function (tile_width, tile_height, max_size, gl_context, texture_type) {
            if (texture_type.type != texture_type_type) {
                console.error("Type of texture_type is not texture_type_type, instead got: " + String(texture_type.type));
                return;
            }
            this.tile_width = tile_width;
            this.tile_height = tile_height;
            this.max_size = max_size;
            this.texture_type = texture_type;
            this.gl_context = gl_context;
            this.texture_gpu = gl_context.createTexture();
            gl_context.bindTexture(gl_context.TEXTURE_2D_ARRAY, this.texture_gpu);
            gl_context.texImage3D(
                gl_context.TEXTURE_2D_ARRAY,
                0,
                this.texture_type.format,
                this.tile_width,
                this.tile_height,
                this.max_size,
                0,
                this.texture_type.format,
                this.texture_type.element_type,
                null,
            );
            return this;
        },
        /** 
         * @brief Function to set data in the tile image. Automatically uses only the first x bytes from the
         * image to set if eg. the given data is from an rgba image and the stored images are only r images.
         * @param {int} i Index of the image that should be set
         * @param {ArrayBuffer} data Image data, needs to have the same byte size as the internal tile 
         */
        set_image_data: function (i, data) {
            const bytes_per_image = this.texture_type.bytes_per_element * this.tile_width * this.tile_height;
            if (data.byteLength != bytes_per_image)
                console.debug("set_image_data(): Image byte size mismatch, will stride through the given data");
            let stride = data.byteLength / bytes_per_image;
            if (1 != stride) {
                console.error("Stride ahs to be one but is " + stride);
                return;
            }
            let t = performance.now();
            this.gl_context.bindTexture(this.gl_context.TEXTURE_2D_ARRAY, this.texture_gpu);
            this.gl_context.texSubImage3D(
                this.gl_context.TEXTURE_2D_ARRAY,
                0, 0, 0, i,
                this.tile_width,
                this.tile_height,
                1,
                this.texture_type.format,
                this.texture_type.element_type,
                data
            );
            this.gl_context.bindTexture(this.gl_context.TEXTURE_2D_ARRAY, null);
        },
        /**
         * @brief uploads the sub image starting at (sx, sy) of the size of a tile without a canvas readback.
         * The default color space conversion is kept (same as drawImage to a canvas), disabling it forces browsers to decode the image again
         * @param {int} i Index of the image that should be set
         * @param {HTMLImageElement} image Loaded image
         */
        set_image_source: function (i, image, sx, sy) {
            const gl = this.gl_context;
            gl.bindTexture(gl.TEXTURE_2D_ARRAY, this.texture_gpu);
            gl.pixelStorei(gl.UNPACK_ROW_LENGTH, image.width);
            gl.pixelStorei(gl.UNPACK_SKIP_PIXELS, sx);
            gl.pixelStorei(gl.UNPACK_SKIP_ROWS, sy);
            gl.texSubImage3D(gl.TEXTURE_2D_ARRAY, 0, 0, 0, i, this.tile_width, this.tile_height, 1,
                             this.texture_type.format, this.texture_type.element_type, image);
            gl.pixelStorei(gl.UNPACK_ROW_LENGTH, 0);
            gl.pixelStorei(gl.UNPACK_SKIP_PIXELS, 0);
            gl.pixelStorei(gl.UNPACK_SKIP_ROWS, 0);
            gl.bindTexture(gl.TEXTURE_2D_ARRAY, null);
        },
        bind_to_shader: function (gl_texture_slot) {
            const gl = this.gl_context;
            gl.activeTexture(gl_texture_slot);
            gl.bindTexture(gl.TEXTURE_2D_ARRAY, this.texture_gpu);
            gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
            gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
            gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
            gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        },
    };
};

/**
 * @brief A tile represents a part of a map, with coordinates (including pyramid depth), last time of use
 * and a function to get the priority of the tile.
 */
const Tile = () => {
    return {
        type: tile_type,
        // member variables
        width: 0,
        tile_x: 0,
        tile_y: 0,
        cascade: 0,             // index of the cascade of the virtual map storing this tile
        lookup_table_string: "",
        last_use: 0,
        load_start: 0,          // time the download of the tile was started
        url: null,              // url or array of urls the tile is loaded from
        /** @type{Image} */
        image: null,
        images: null,
        loaded: false,
        load_error: false,
        data_uploaded_to_gpu: false,
        height_range: null,     // [min, max] height in meters, only filled for heightmap tiles
        height_grid: null,      // Float32Array with the max height of each 4x4 texel block in meters, only filled for heightmap tiles
        height_grid_mean: null, // Float32Array with the mean height of each 4x4 texel block in meters, only filled for heightmap tiles

        // member functions
        /**
         * @param {string}   tile_url Url from where the data has to be loaded
         * @param {int}      width Width of the tile in amount of tiles
         * @param {int}      tile_x Starting coordinate x in the tile texture (so start of the tile in the most precise level)
         * @param {int}      tile_y Starting coordinate y in the tile texture (so start of the tile in the most precise level)
         * @param {int}      cascade Index of the cascade of the virtual map storing this tile
         */
        init: function (tile_url, tile_x, tile_y, width, cascade) {
            this.width = width;
            this.tile_x = tile_x;
            this.tile_y = tile_y;
            this.cascade = cascade;
            this.url = tile_url;
            this.lookup_table_string = CoordinateMappings.coords_to_lookup_string(tile_x, tile_y, width);
            this.last_use = Date.now();
            this.load_start = this.last_use;
            if (Array.isArray(tile_url)) {
                this.images = [];
                this.loaded = Array(tile_url.length).fill(false);
                this.load_error = Array(tile_url.length).fill(false);
                tile_url.forEach((url, t) => {
                    const img = new Image();
                    this.images[t] = img;
                    this.load_image(img, url, () => this.images && this.images[t] === img, (ok) => {this.loaded[t] = true; this.load_error[t] = !ok;});
                });
            } else {
                const img = new Image();
                this.image = img;
                this.load_image(img, tile_url, () => this.image === img, (ok) => {this.loaded = true; this.load_error = !ok;});
            }
            return this;
        },
        /**
         * @brief loads the image and decodes it with decode() which runs off the main thread, otherwise the decode
         * would happen synchronously in drawImage. Images are kept (instead of fetch + createImageBitmap) as the
         * browser image cache avoids downloading and decoding an image again when a tile is requested again
         * @param {function():bool} still_needed False if the tile was reset or reused in the meantime
         * @param {function(bool):void} done Called with false on a load error
         */
        load_image: function (img, url, still_needed, done) {
            img.crossOrigin = 'anonymous';
            // a failed decode() is no load error, drawImage then decodes synchronously
            img.onload = () => {
                let finished = false;
                const finish = () => { if (!finished && still_needed()) done(true); finished = true; };
                img.decode().catch(() => {}).then(finish);
                setTimeout(finish, tile_decode_timeout_ms);
            };
            img.onerror = () => { if (still_needed()) done(false); };
            img.src = url;
        },
        /**
         * @returns {float} with a priority value that is the higher the more important this tile is
         */
        get_priority: function () { return this.is_initialized() ? -(Date.now() - this.last_use) + Math.log2(this.width) * coarse_level_priority_ms : -Infinity; },
        is_initialized: function () {return this.width != 0;},
        reset: function() {
            this.width = 0; 
            this.tile_x = 0; 
            this.tile_y = 0;
            this.cascade = 0;
            this.url = null;
            this.lookup_table_string = "";
            this.last_use = 0;
            this.load_start = 0;
            if (this.image) {
                this.image.src = "";
                this.image = null;
            }
            if (this.images) {
                for (const img of this.images)
                    img.src = "";
                this.images = null;
            }
            this.loaded = false;
            this.load_error = false;
            this.data_uploaded_to_gpu = false;
            this.height_range = null;
            this.height_grid = null;
            this.height_grid_mean = null;
        }
    };
};

/**
 * @brief Represents a tile that is needed for rendering
 * 
 * It contains all needed elements to actually load the final data as well
 * For translation from world coordinates to the correct image space coordinates/
 * mapping to the correct url there exists the tile_request_from_global_coordinate function in the
 * CoordinateMapping object
 * So do not initialize yourself
 */
const TileRequest = () => {
    return {
        type: tile_request_type,
        // member variables
        x: 0,
        y: 0,
        level: 0,
        url: "",
        offsets: {x: 0, y: 0, z: 0},

        // member functions
        init: function (x, y, level, url, offsets = {x: 0, y: 0, z: 0}) { this.x = x; this.y = y; this.level = level; this.url = url; this.offsets = offsets; return this; },
    };
};

const MapProvider = () => {
    return {
        type: map_provider_type,
        // member variables
        base_url: "",
        /** @type {function(int, int, int): String} */
        coords_to_path: null,
        /** @type {function(width: int): int} */
        virtual_texture_tile_span: null,
        min_lat: 0,
        max_lat: 0,
        min_lon: 0,
        max_lon: 0,

        // member functions
        /**
         * @param {String} base_url 
         * @param {function(int, int, int): String} coords_to_path 
         * @param {int} min_lat
         * @param {int} min_lat
         * @param {int} max_lat
         * @param {int} min_lon
         * @param {int} max_lon
         */
        init: function (base_url, coords_to_path, virtual_texture_tile_span, min_lat, max_lat, min_lon, max_lon) {
            this.base_url = base_url;
            this.coords_to_path = coords_to_path;
            this.virtual_texture_tile_span = virtual_texture_tile_span;
            this.min_lat = min_lat;
            this.max_lat = max_lat;
            this.min_lon = min_lon;
            this.max_lon = max_lon;
            return this;
        },
        /**
         * @brief checks if a given coordinate is supported by this provider
         * @param {int} lat 
         * @param {int} lon 
         */
        supports_point: function (lat, lon) { return lat >= this.min_lat && lat <= this.max_lat && lon >= this.min_lon && lon <= this.max_lon; }
    };
};
const MapProviders = {
    // heightmap providers -------------------------------------------
    height_minifuzi: MapProvider().init(
        "https://minifuziserver.duckdns.org:12345/tiles",
        (lat, lon, width) => {
            return "";
        },
        (width) => { return 0; },
        0, 0, 0, 0
    ),
    height_row: MapProvider().init(
        "https://da kommt er",
        (lat, lon, width) => {
            return "";
        },
        (width) => { return 0; },
        0, 0, 0, 0
    ),
    // satellite providers -------------------------------------------
    satellite_bayernatlas: MapProvider().init(
        "https://bayernatlas url",
        (lat, lon, width) => {
            return "";
        },
        (width) => { return 0; },
        0, 0, 0, 0
    ),
    satellite_row: MapProvider().init(
        "https://row",
        (lat, lon, width) => {
            return "";
        },
        (width) => { return 0; },
        0, 0, 0, 0
    ),
    // street view providers -----------------------------------------
    street_view_bayernatlas: MapProvider().init(
        "https://bayernatlas url",
        (lat, lon, width) => {
            return "";
        },
        (width) => { return 0; },
        0, 0, 0, 0
    ),
    street_view_row: MapProvider().init(
        "https://row url",
        (lat, lon, width) => {
            return "";
        },
        (width) => { return 0; },
        0, 0, 0, 0
    ),
    // parcel borders providers --------------------------------------
    parcel_borders_bayernatlas: MapProvider().init(
        "https://bayernatlas url",
        (lat, lon, width) => {
            return "";
        },
        (width) => { return 0; },
        0, 0, 0, 0
    ),
};

const MapType = {
    height: 0,
    satellite: 1,
    street_view: 2,
    parcel_borders: 3,
};

const CoordinateMappings = {
    tile_request_from_global_coordinate: function (lat, lon, pref_width) {
        let tile_base_lat = lat;
        let tile_base_lon = lon;
        let tile_width = pref_width;
        let tile_url = "";
        let tile = TileRequest().init(tile_base_lat, tile_base_lon, tile_width, tile_url);
        return tile;
    },
    /**
     * @param {int} x 
     * @param {int} y 
     * @param {int} width 
     * @returns {String} containing the input parameters concatenated via /
     */
    coords_to_lookup_string: function (x, y, width) {
        return `${width}/${x}/${y}`;
    },
    /**
     * @param {String} str String containing "lat/lon/width" in exactly this order
     * @returns {Object} with member variables lat, lon, width filled
     */
    lookup_string_to_coords: function (str) {
        let s = str.split("/");
        return { lat: +s[0], lon: +s[1], width: +s[2] };
    },
    /**
     * @brief Main function to map from world coordinate to the different map providers
     * @param {int} lat 
     * @param {int} lon 
     * @param {int} width 
     * @param {int} map_type A value of the MapType enum
     * @return {String} with a full path to download the final image tile
     */
    global_coordinate_to_tile_url: function (lat, lon, width, map_type) {
        let provider = this.global_coordinate_to_provider(lat, lon, map_type);
        if (!provider) {
            console.error("No provider found")
            return "";
        }
        return provider.coords_to_path(lat, lon, width);
    },
};

const Util = {
    meter_per_degree: 111320, // 1 degree of latitude is approximately 111,320 meters
    meter_per_uv: 40000000, // 1uv is once around the earth, so 1 uv = 40e 10e6 m

    /**
     * @brief creates a new canvas context. When the returned context is not used anymore
     * it is freed automatically
     * @param {int} width 
     * @param {int} height 
     * @param {String} context_type 
     * @returns {RenderingContext}
     */
    create_canvas_context: function (width, height, context_type = '2d') {
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        return canvas.getContext(context_type, {willReadFrequently: true, antialias: true});
    },
    
    wgs_84_to_uv: function (lat, lon) {
        let x = lon * Math.PI / 180;
        let y = Math.asinh(Math.tan(lat * Math.PI / 180));
        x = (1 + (x / Math.PI)) / 2;
        y = (1 - (y / Math.PI)) / 2;
        return [x, y];
    },
    /**
     * @brief transforms coordinates from wgs_86 to tile index
     * @param {double} lat latitude in degrees nord/south 
     * @param {double} height latitude in degress east/west
     */
    wgs_84_to_tile_idx: function (lat, lon, level) {
        let uv = this.wgs_84_to_uv(lat, lon);
        return [Math.floor(uv[0] * (1 << level)), Math.floor(uv[1] * (1 << level))];
    },
    glsl_wgs_84_to_uv: function () {
        return `
        vec2 wgs_84_to_uv(vec2 pos) {
            float x = pos.y * PI / 180.;
            float y = asinh(tan(pos.x * PI / 180.));
            return vec2((1.0 + (x / PI)) / 2., (1.0 - (y / PI)) / 2.); // global tile uv
        }
        `;
    },

    m_to_wgs_84_deg: function (m) {
        // using a default value to convert (is not accurate in the longitudinal direction due to ignoring the shortening on the glob sphere)
        return m / this.meter_per_degree;
    },
    m_to_wgs_84_uv: function (m) {
        // using a default value to convert (is not accurate in the longitudinal direction due to ignoring the shortening on the glob sphere)
        return m / this.meter_per_uv;
    },

    wgs_84_ddeg_to_m: function (ddeg) {
        return ddeg * this.meter_per_degree;
    },
    wgs_84_uv_to_m: function (uv) {
        return uv * this.meter_per_uv;
    },

    glsl_wgs_84_uv_to_m: function () {
        return `
        float wgs_84_uv_to_m(float m) {
            return m * ${this.meter_per_uv}.;
        }
        `;
    },
    glsl_wgs_84_m_to_uv: function () {
        return `
        float wgs_84_m_to_uv(float m) {
            return m * ${1 / this.meter_per_uv};
        }
        `;
    },
    max_tile_level: 22,     // deepest tile level of all maps
    glsl_calc_level: function () {
        return `
        float get_level(float d2) {
            float max_l = ${this.max_tile_level}.;
            float mip_offset = max_l + 6.5;
            return max_l - clamp(.5 * log2(d2) + mip_offset, 0., max_l);
        }
        // squared uv footprint of a pixel for the level selection. The larger axis is used, the anisotropy is limited
        // to 4 (16 squared) to keep some sharpness at glancing angles without requesting the finest tiles up to the horizon
        float get_footprint(vec2 dx, vec2 dy) {
            float dx2 = dot(dx, dx), dy2 = dot(dy, dy);
            return min(max(dx2, dy2), min(dx2, dy2) * 16.);
        }
        `
    },
    /**
     * @brief the tile needed at a fragment is encoded as level << 26 | x << 13 | y. For levels > 13 x and y are relative
     * to the tile containing grid_offset_pos (offset by 4096) to fit into 13 bits. 0xffffffff for not encodable tiles
     */
    glsl_get_tile_index: function () {
        return `
        uint get_tile_index() {
            vec2 dx = dFdx(loc_pos);
            vec2 dy = dFdy(loc_pos);
            float max_del = get_footprint(dx, dy);
            int level = int(get_level(max_del));
            float n = float(1 << level);
            vec2 g = grid_offset_pos * n;   // exact as n is a power of 2
            ivec2 xy = ivec2(floor(fract(g) + loc_pos * n));
            if (level <= 13)
                xy = (xy + ivec2(floor(g))) & ivec2((1 << level) - 1);
            else
                xy += 4096;
            if (xy != clamp(xy, ivec2(0), ivec2(8191)))
                return 0xffffffffu;
            return uint(level) << 26 | uint(xy.x) << 13 | uint(xy.y);
        }
        `;
    },
    /** @brief decodes the tile ids written by get_tile_index(), grid_offset_pos has to be the f32 one used for rendering */
    int32_to_tile_id: function (tiles, grid_offset_pos) {
        return Array.from(tiles, id => {
            const level = id >>> 26;
            let x = (id >>> 13) & 0x1fff;
            let y = id & 0x1fff;
            if (level > 13) {
                const n = 2 ** level;
                x = (x + Math.floor(grid_offset_pos.x * n) - 4096 + n) % n;
                y += Math.floor(grid_offset_pos.y * n) - 4096;
            }
            return {level: level, x: x, y: y};
        }).filter(t => t.y >= 0 && t.y < 2 ** t.level);
    },

    /**
     * @brief uniforms and tile lookup for a virtual map, has to be included before any other virtual map glsl function
     * @param {VirtualMap} virtual_map the virtual map which will be bound, needed for the array sizes
     */
    glsl_virtual_texture_uniforms: function (v_map_name, virtual_map) {
        const cascades = virtual_map.cascades.length;
        const index_res = 1 << cascade_index_res_log2;
        return `
        uniform usampler2DArray virtual_${v_map_name}_index;    // one layer per cascade
        uniform sampler2DArray virtual_${v_map_name};
        layout(std140) uniform Infos_${v_map_name} {
            vec4 virtual_${v_map_name}_cascades[${cascades}];   // xy: window offset in uv, z: index texels per uv, w: max tile level
            ivec4 virtual_${v_map_name}_infos[${cascades * virtual_map.max_tiles}];   // xy: tile position, z: tile width (in tiles of max level), w: parent index or -1
        };
        // returns in x the index of the deepest loaded tile at the position with level <= the given level and in y the index
        // of its next deeper loaded tile (x if there is none), -1 if no tile is loaded
        ivec2 virtual_${v_map_name}_find_tile(vec2 uv_offset, vec2 uv_loc, float level) {
            int index = -1;
            for (int c = ${cascades - 1}; c >= 0 && index < 0; --c) {
                vec4 cascade = virtual_${v_map_name}_cascades[c];
                ivec2 texel = ivec2(floor(((uv_offset - cascade.xy) + uv_loc) * cascade.z));
                if (c == 0)
                    texel &= ivec2(${index_res - 1});   // the first cascade covers the whole world
                else if (texel != clamp(texel, ivec2(0), ivec2(${index_res - 1})))
                    continue;
                uint i = texelFetch(virtual_${v_map_name}_index, ivec3(texel, c), 0).x;
                if (i != 0u)
                    index = int(i) - 1 + c * ${virtual_map.max_tiles};
            }
            if (index < 0)
                return ivec2(-1);
            int child = index;
            for (int cur_l = int(virtual_${v_map_name}_cascades[0].w) - int(round(log2(float(virtual_${v_map_name}_infos[index].z))));  // widths are powers of 2
                 cur_l > int(level) && virtual_${v_map_name}_infos[index].w >= 0;
                 --cur_l) {
                child = index;
                index = virtual_${v_map_name}_infos[index].w;
            }
            return ivec2(index, child);
        }
        // uv inside of the tile at index
        vec2 virtual_${v_map_name}_tile_uv(int index, vec2 uv_offset, vec2 uv_loc) {
            float v_tex_width = exp2(virtual_${v_map_name}_cascades[0].w);
            ivec4 info = virtual_${v_map_name}_infos[index];
            // the tile origin is subtracted before adding uv_loc to keep the precision for deep levels
            return ((uv_offset - vec2(info.xy) / v_tex_width) + uv_loc) * (v_tex_width / float(info.z));
        }
        int virtual_${v_map_name}_tile_level(int index) {
            return int(virtual_${v_map_name}_cascades[0].w) - int(round(log2(float(virtual_${v_map_name}_infos[index].z))));
        }
        // texel of the tile at index, image_uv is the position of uv_loc in its pixels. Texels outside of the tile are
        // fetched from the neighboring tile (same or coarser level), otherwise each tile would end with a visible seam.
        // The border texel of the tile is used if the neighbor is not loaded
        vec4 virtual_${v_map_name}_fetch(int index, vec2 uv_offset, vec2 uv_loc, vec2 image_uv, ivec2 texel) {
            ivec2 size = textureSize(virtual_${v_map_name}, 0).xy;
            if (texel != clamp(texel, ivec2(0), size - 1)) {
                // the neighbor is searched at the texel center, given relative to uv_loc to keep the precision for deep levels
                float tile_w = float(virtual_${v_map_name}_infos[index].z) / exp2(virtual_${v_map_name}_cascades[0].w);
                vec2 n_loc = uv_loc + (vec2(texel) + .5 - image_uv) / vec2(size) * tile_w;
                int n = virtual_${v_map_name}_find_tile(uv_offset, n_loc, float(virtual_${v_map_name}_tile_level(index))).x;
                if (n >= 0) {
                    index = n;
                    texel = ivec2(floor(virtual_${v_map_name}_tile_uv(n, uv_offset, n_loc) * vec2(size)));
                }
                texel = clamp(texel, ivec2(0), size - 1);
            }
            return texelFetch(virtual_${v_map_name}, ivec3(texel, index), 0);
        }
        // bilinear sample of the tile at index, near the tile border the interpolation continues into the neighbor tiles
        vec4 virtual_${v_map_name}_sample(int index, vec2 uv_offset, vec2 uv_loc) {
            vec2 size = vec2(textureSize(virtual_${v_map_name}, 0).xy);
            vec2 tuv = virtual_${v_map_name}_tile_uv(index, uv_offset, uv_loc);
            vec2 image_uv = tuv * size;
            if (image_uv == clamp(image_uv, vec2(.5), size - .5))    // fast path, the hardware filter stays inside of the tile
                return texture(virtual_${v_map_name}, vec3(tuv, float(index)));
            vec2 p = image_uv - .5;     // texel centers are at i + .5
            ivec2 i = ivec2(floor(p));
            vec2 a = p - vec2(i);
            return mix(mix(virtual_${v_map_name}_fetch(index, uv_offset, uv_loc, image_uv, i),
                           virtual_${v_map_name}_fetch(index, uv_offset, uv_loc, image_uv, i + ivec2(1, 0)), a.x),
                       mix(virtual_${v_map_name}_fetch(index, uv_offset, uv_loc, image_uv, i + ivec2(0, 1)),
                           virtual_${v_map_name}_fetch(index, uv_offset, uv_loc, image_uv, i + ivec2(1, 1)), a.x), a.y);
        }
        `;
    },

    glsl_virtual_texture_load: function (v_map_name) {
        return `
        vec4 virtual_${v_map_name}_load(vec2 uv_offset, vec2 uv_loc, float level) {
            ivec2 tiles = virtual_${v_map_name}_find_tile(uv_offset, uv_loc, level);
            if (tiles.x < 0)
                return vec4(0);
            vec4 c = virtual_${v_map_name}_sample(tiles.x, uv_offset, uv_loc);
            vec4 t = tiles.y == tiles.x ? c : virtual_${v_map_name}_sample(tiles.y, uv_offset, uv_loc);
            // blending to the next deeper tile
            float alpha = clamp(level - floor(level), 0., 1.);
            alpha = alpha * 10. - 5.;
            alpha = (alpha / (1. + abs(alpha))) * .5 + .5;
            return mix(c, t, alpha);
        }
        `;
    },
    glsl_virtual_heightmap_load: function() {
        return `
        float decode_height(vec4 encoded_height){
            if (encoded_height == vec4(0))
                return 0.;
            encoded_height = encoded_height * 255.; 
            return (encoded_height.r * 256. + encoded_height.g + encoded_height.b / 256.) - 32768.;
        }
        vec3 create_normal(float dx, float dy, float w) {
            return normalize(cross(vec3(w, 0, dx), vec3(0, w, dy)));
        }
        float virtual_heightmap_height(int index, vec2 uv_offset, vec2 uv_loc, vec2 image_uv, ivec2 texel) {
            return decode_height(virtual_heightmap_fetch(index, uv_offset, uv_loc, image_uv, texel));
        }
        // returns the height in x, and the normal in yzw
        vec4 virtual_heightmap_load(vec2 uv_offset, vec2 uv_loc, float level) {
            int index = virtual_heightmap_find_tile(uv_offset, uv_loc, level).x;
            if (index < 0)
                return vec4(0);
            float width = float(virtual_heightmap_infos[index].z);
            // texel centers are at i + .5, neighbors outside of the tile are taken from the adjacent tiles such that
            // heights and normals are continuous over tile borders
            vec2 image_uv = virtual_heightmap_tile_uv(index, uv_offset, uv_loc) * 256.;    // assumes always a tile size of 256
            vec2 p = image_uv - .5;
            ivec2 i = ivec2(floor(p));
            vec2 a = p - vec2(i);
            float d00 = virtual_heightmap_height(index, uv_offset, uv_loc, image_uv, i);
            float d10 = virtual_heightmap_height(index, uv_offset, uv_loc, image_uv, i + ivec2(1, 0));
            float d01 = virtual_heightmap_height(index, uv_offset, uv_loc, image_uv, i + ivec2(0, 1));
            float d11 = virtual_heightmap_height(index, uv_offset, uv_loc, image_uv, i + ivec2(1, 1));
            // negative side pixels for the normals
            float dn10 = virtual_heightmap_height(index, uv_offset, uv_loc, image_uv, i + ivec2(-1, 0));
            float dn01 = virtual_heightmap_height(index, uv_offset, uv_loc, image_uv, i + ivec2(0, -1));
            float dn1p1 = virtual_heightmap_height(index, uv_offset, uv_loc, image_uv, i + ivec2(-1, 1));
            float dp1n1 = virtual_heightmap_height(index, uv_offset, uv_loc, image_uv, i + ivec2(1, -1));
            float gw = width / 4.;
            vec3 t = mix(mix(vec3(d00, d00 - dn10, d00 - dn01), vec3(d10, d10 - d00, d10 - dp1n1), a.x), 
                         mix(vec3(d01, d01 - dn1p1, d01 - d00 ), vec3(d11, d11 - d01, d11 - d10 ), a.x), a.y);
            return vec4(t.x, create_normal(t.y, t.z, gw));
        }
        `;
    },

    
    add_missing_parent_tiles: function(tiles) {
        let available_tiles = new Set();
        const t_str = (e) => {return `${e.level}|${e.x}|${e.y}`;};
        tiles.forEach(e => available_tiles.add(t_str(e)));
        for (let i = 0; i < tiles.length; ++i) {
            let c = tiles[i];
            let cur_x = c.x;
            let cur_y = c.y;
            for (let l = c.level - 1; l >= 0; --l) {
                cur_x = cur_x >> 1;
                cur_y = cur_y >> 1;
                c = {x: cur_x, y: cur_y, level: l};
                if (available_tiles.has(t_str(c)))
                    continue;
                tiles.push(c);
                available_tiles.add(t_str(c));
            }
        }
    },

    execution_break: async function () {
        await new Promise(resolve => setTimeout(resolve, 0));
    }
};

/** @brief resolves when the sync is signaled, rejects on failure or if it is not signaled within timeout_ms */
const clientWaitAsync = function (gl, sync, flags = 0, interval_ms = 10, timeout_ms = 2000) {
    const start = performance.now();
    return new Promise(function (resolve, reject) {
        var check = function () {
            var res = gl.clientWaitSync(sync, flags, 0);
            if (res == gl.WAIT_FAILED) {
                reject(new Error("clientWaitSync failed"));
                return;
            }
            if (res == gl.TIMEOUT_EXPIRED) {
                if (performance.now() - start > timeout_ms) {
                    reject(new Error("sync not signaled in time"));
                    return;
                }
                setTimeout(check, interval_ms);
                return;
            }
            resolve();
        };
        check();
    });
};
