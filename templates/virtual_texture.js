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
const priority_time_factor = 1.;

const VirtualMap = () => {
    return {
        type: virtual_map_type,
        // member variables
        tile_width: 0,
        tile_height: 0,
        max_tiles: 0,
        v_tex_height: 0,
        v_tex_width: 0,
        v_tex_coarse_width: 0,
        v_tex_coarse_height: 0,
        v_tex_detail_width: 0,
        v_tex_detail_height: 0,
        v_tex_detail_center_tile: {x: 0, y: 0},    // describes the center of the detail tiles in the most bottom tile layer (int coords)
        v_tex_detail_level_thresh: 0,
        v_tex_extent: { min_lat: 0, max_lat: 0, min_lon: 0, max_lon: 0 },
        /** @type {{key: int}} */
        tiles_lookup_table: {}, // is a lookup table which maps a string containing "{lat}/{lon}/{width}" to an index
        tiles_lookup_table_detail: {}, // is a lookup table which maps a string containing "{lat}/{lon}/{width}" to an index
        /** @type {TilesGpu} */
        tiles_storage_gpu: null,
        /** @type {WebGL2Buffer} */
        tiles_infos_buffer: null,
        /** @type {Array.<Tile>} */
        tiles_storage_cpu: [],
        tiles_storage_cpu_detail: [],
        virtual_texture_byte_size: 0, // is determined according to the max_tiles parameter
        virtual_texture_rebuilt: false, // used to determine whether view has to be rerendered due to an updated virtual texture cache
        /** @type {Texture} */
        virtual_texture_gpu: null,
        virtual_texture_gpu_detail: null,
        /** @type {WebGLFramebuffer} */
        virtual_texture_fb: null,
        virtual_texture_detail_fb: null,
        virtual_texture_render_pipeline: null,
        /** @type {WebGL2RenderingContext} */
        gl_context: null,
        image_canvas_context: null,

        // functions
        /**
         * @param {int} v_tex_width The amount of tiles at highest precision available (will be the texture width of the lookup texture)
         * @param {int} v_tex_height The amount of tiles at highest precision available (will be the texture height of the lookup texture)
         * @param {{min_lat: int, max_lat:int, min_lon: int, max_lon:int}} v_tex_extent The geographical extent of the texture
         * @param {int} tile_width The width of a single tile (no matter which detail level, all have to be the same size) in pixels
         * @param {int} tile_height The height of a single tile (no matter which detail level, all ahv eto be the same size) in pixels
         * @param {int} max_tiles The maximum amount of tiles stored in virtual texture cache (it is advised to use 255, or 511)
         * @param {WebGL2RenderingContext} gl_context 
         */
        init: function (v_tex_width, v_tex_height, v_tex_extent, tile_width, tile_height, max_tiles, texture_type, gl_context) {
            this.tile_width = tile_width;
            this.tile_height = tile_height;
            this.max_tiles = max_tiles;
            this.v_tex_width = v_tex_width;
            this.v_tex_height = v_tex_height;
            this.v_tex_extent = v_tex_extent;
            this.v_tex_coarse_width = Math.min(1 << 11, v_tex_width);
            this.v_tex_coarse_height = Math.min(1 << 11, v_tex_height);
            this.v_tex_detail_width = Math.min(1 << 11, v_tex_width * 16 / this.v_tex_coarse_width);
            this.v_tex_detail_height = Math.min(1 << 11, v_tex_height * 16 / this.v_tex_coarse_height);
            this.v_tex_detail_level_thresh = Math.log2(this.v_tex_coarse_width);
            console.log("Initializing a virtual map with the following parts:");
            console.log(this);
            this.tiles_storage_gpu = TilesGpu().init(tile_width, tile_height, max_tiles, gl_context, texture_type);
            this.tiles_infos_buffer = gl_context.createBuffer();
            gl_context.bindBuffer(gl_context.UNIFORM_BUFFER, this.tiles_infos_buffer);
            gl_context.bufferData(gl_context.UNIFORM_BUFFER, new Int32Array(max_tiles * 4 * 2), gl_context.DYNAMIC_DRAW);
            gl_context.bindBuffer(gl_context.UNIFORM_BUFFER, null);
            this.virtual_texture_byte_size = Math.ceil(Math.ceil(Math.log2(max_tiles)) / 8); // get the bits required (log2) and then convert them to required bytes
            const format = TextureTypes(gl_context).ui8r;   // always is 1 byte
            this.virtual_texture_gpu = gl_context.createTexture();
            gl_context.bindTexture(gl_context.TEXTURE_2D, this.virtual_texture_gpu);
            gl_context.texImage2D(gl_context.TEXTURE_2D, 0, format.format, v_tex_width, v_tex_height, 0, format.format_cpu || format.format, format.element_type, null);
            gl_context.texParameteri(gl_context.TEXTURE_2D, gl_context.TEXTURE_MIN_FILTER, gl_context.NEAREST);
            gl_context.texParameteri(gl_context.TEXTURE_2D, gl_context.TEXTURE_WRAP_S, gl_context.REPEAT);
            gl_context.texParameteri(gl_context.TEXTURE_2D, gl_context.TEXTURE_WRAP_T, gl_context.REPEAT);
            this.virtual_texture_gpu_detail = gl_context.createTexture();
            gl_context.bindTexture(gl_context.TEXTURE_2D, this.virtual_texture_gpu_detail);
            gl_context.texImage2D(gl_context.TEXTURE_2D, 0, format.format, v_tex_width, v_tex_height, 0, format.format_cpu || format.format, format.element_type, null);
            gl_context.texParameteri(gl_context.TEXTURE_2D, gl_context.TEXTURE_MIN_FILTER, gl_context.NEAREST);
            this.virtual_texture_fb = gl_context.createFramebuffer();
            gl_context.bindFramebuffer(gl_context.FRAMEBUFFER, this.virtual_texture_fb);
            gl_context.framebufferTexture2D(gl_context.FRAMEBUFFER, gl_context.COLOR_ATTACHMENT0, gl_context.TEXTURE_2D, this.virtual_texture_gpu, 0);
            this.virtual_texture_detail_fb = gl_context.createFramebuffer();
            gl_context.bindFramebuffer(gl_context.FRAMEBUFFER, this.virtual_texture_detail_fb);
            gl_context.framebufferTexture2D(gl_context.FRAMEBUFFER, gl_context.COLOR_ATTACHMENT0, gl_context.TEXTURE_2D, this.virtual_texture_gpu_detail, 0);
            const pipeline = initShaderProgram(gl_context,
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
            return this;
        },
        /** @param {Array.<TileRequest>} tile_requests Tiles which are needed next frame */
        update_needed_tiles: function (tile_requests) {
            // sorting the tile requests to have the highest detailed images last to guarantee that
            // detail images will have a later time stamp (important for correctly loading the lods)
            tile_requests.sort((a, b) => a.width > b.width);
            // updating the center of the detail view according to the distance of the most detailed
            // tile to the current detail view (such that it tries to stay centered)
            const t = tile_request[tile_requests.length - 1];
            const tile_width_bits = Math.log2(this.v_tex_width);
            if (t.level >= this.v_tex_detail_level_thresh) {
                let shift = tile_width_bits - tile_req.level;
                let width = (1 << shift);
                let final_x = t.x * width;
                let final_y = t.y * width;
                const c_x = final_x + .5 * width;
                const c_y = final_y + .5 * width;
                const detail_width = this.v_tex_detail_width;
                const detail_height = this.v_tex_detail_height;
                let center = this.v_tex_detail_center_tile;
                // check if difference is outside the 75% center area -> recenter
                if (Math.abs(c_x - center.x) > detail_width * .3 ||
                    Math.abs(c_y - center.y) > detail_height * .3) {
                    center.x = Math.floor(c_x);
                    center.y = Math.floor(c_y);
                    // go through all detail images and check if they have to be deleted
                    let del_indices = [];
                    let detail_tiles = this.tile_storage_cpu_detail;
                    for (let i = 0; i < detail_tiles.length; ++i) {
                        let cur_t = detail_tiles[i];
                        if (Math.abs(cur_t.tile_x - center.x) + cur_t.width >= .5 * detail_width ||
                            Math.abs(cur_t.tile_y - center.y) + cur_t.width >= .5 * detail_width)
                            del_indices.push(i);
                    }
                    console.log("Deleting some detail tiles:");;
                    console.log(del_indices);
                    del_indices.foreach(i => this.drop_tile_at_index(i, false));
                }
            }
            for (tile_req of tile_requests) {
                if (tile_req.type != tile_request_type) {// ignore wrong type tiles
                    console.error("Wrong type for tile request, got type: " + String(tile_req.type));
                    continue;
                }
                if (tile_req.level > tile_width_bits) {
                    console.warn("Too deep level for this virtual texture. Ignoring");
                    continue;
                }
                let shift = tile_width_bits - tile_req.level;
                let width = (1 << shift);
                if (tile_req.x + width >= this.v_tex_width || tile_req.y + width >= this.v_tex_height) {
                    console.warn("Too large tile, likely a too deep level. ignoring");
                    continue;
                }
                let final_x = tile_req.x * width;
                let final_y = tile_req.y * width;
                const coarse = tile_req.level < this.v_tex_detail_level_thresh;
                let lookup_table_string = CoordinateMappings.coords_to_lookup_string(final_x, final_y, width);
                let tiles_storage = coarse ? this.tiles_storage_cpu: this.tiles_storage_cpu_detail;
                let tiles_lookup = coarse ? this.tiles_lookup_table: this.tiles_lookup_table_detail;
                let already_loaded = lookup_table_string in tiles_lookup;
                // make space for a new tile if tile cache full
                if (!already_loaded && tiles_storage.length >= this.max_tiles)
                    this.drop_least_important_tiles(10, coarse);
                // add new tile to the storage
                if (!already_loaded) {
                    let i_gpu = this.tiles_storage_gpu.reserve_image_tile(coarse);
                    let i_cpu = tiles_storage.length;
                    if (i_gpu != i_cpu)
                        console.error("Added index mismatch for tiles");
                    tiles_storage.push(Tile());
                    let t = tiles_storage[i_cpu];
                    t.init(
                        tile_req.url,
                        final_x,
                        final_y,
                        width,
                        () => { t.loaded = true; }
                    )
                    if (final_x + width > this.v_tex_width || final_y + width > this.v_tex_height)
                        console.error("VirtualTexture::update_needed_tiles() new tile invalid x/y");
                    tiles_lookup[lookup_table_string] = i_cpu;
                }
                // finally update the last use time
                let i = tiles_lookup[lookup_table_string];
                tiles_storage[i].last_use = Date.now();
                // the virtual texture is updated when a new image had to be loaded/was loaded (see image_i_loaded_callback)
            }
            console.log(this.tiles_lookup_table);
        },
        /** @brief updates the virtual texture to contain the correct textures stored in the virtual texture cache */
        rebuild_virtual_texture: async function () {
            // filling is done by ordering all tiles according to their last use time stamp and then writing them into the cpu buffer first the latest needed textures
            // and then filling the rest of the holes with texels out of the lower quality textures
            let t = performance.now();

            if (this.virtual_texture_byte_size != 1 && this.virtual_texture_byte_size != 2) {
                console.error("Only tile_size allowed which can be indexed by at most 2 bytes, currently need " + this.virtual_texture_byte_size + " bytes");
                return;
            }

            // filling coarse virtual_texture_cpu -------------------------------------------
            const gl = this.gl_context;
            let ordered_tiles = this.tiles_storage_cpu.map((x, i) => [x.width, i]).sort((a, b) => b[0] - a[0]);
            gl.bindFramebuffer(gl.FRAMEBUFFER, this.virtual_texture_fb);
            gl.viewport(0, 0, this.v_tex_coarse_width, this.v_tex_coarse_height);
            gl.disable(gl.DEPTH_TEST);
            gl.disable(gl.CULL_FACE);
            gl.useProgram(this.virtual_texture_render_pipeline.program);
            gl.uniform2i(this.virtual_texture_render_pipeline.uniforms.image_size, this.v_tex_coarse_width, this.v_tex_coarse_height);

            // clear the whole image
            gl.uniform4i(this.virtual_texture_render_pipeline.uniforms.bounds, 0, this.v_tex_coarse_width, 0, this.v_tex_coarse_height);
            gl.uniform1ui(this.virtual_texture_render_pipeline.uniforms.index, 0);
            gl.drawArrays(gl.TRIANGLES, 0, 6);

            const s = this.v_tex_coarse_width / this.v_tex_width;
            for ([last_use, idx] of ordered_tiles) {
                let tile = this.tiles_storage_cpu[idx];
                if (!tile.data_uploaded_to_gpu) // ignore not uploaded tiles (will be updated later due to callback which calls this function in its final steps)
                    continue;

                gl.uniform4i(this.virtual_texture_render_pipeline.uniforms.bounds, tile.tile_x * s, (tile.tile_x + tile.width) * s, tile.tile_y * s, (tile.tile_y + tile.width) * s);
                gl.uniform1ui(this.virtual_texture_render_pipeline.uniforms.index, idx + 1);
                
                gl.drawArrays(gl.TRIANGLES, 0, 6);
            }
            // filling detail virtual_texture_cpu -------------------------------------------
            ordered_tiles = this.tiles_storage_cpu_detail.map((x, i) => [x.width, i]).sort((a, b) => b[0] - a[0]);
            gl.bindFramebuffer(gl.FRAMEBUFFER, this.virtual_texture_detail_fb);
            gl.viewport(0, 0, this.v_tex_detail_width, this.v_tex_detail_height);
            gl.uniform2i(this.virtual_texture_render_pipeline.uniforms.image_size, this.v_tex_detail_width, this.v_tex_detail_height);

            // clear the whole image
            gl.uniform4i(this.virtual_texture_render_pipeline.uniforms.bounds, 0, this.v_tex_detail_width, 0, this.v_tex_detail_height);
            gl.uniform1ui(this.virtual_texture_render_pipeline.uniforms.index, 0);
            gl.drawArrays(gl.TRIANGLES, 0, 6);

            const t_x = (x) => {return (x - this.v_tex_detail_center_tile.x) / this.v_tex_width * this.v_tex_detail_width;};
            const t_y = (y) => {return (y - this.v_tex_detail_center_tile.y) / this.v_tex_width * this.v_tex_detail_width;};
            for ([last_use, idx] of ordered_tiles) {
                let tile = this.tiles_storage_cpu[idx];
                if (!tile.data_uploaded_to_gpu) // ignore not uploaded tiles (will be updated later due to callback which calls this function in its final steps)
                    continue;

                gl.uniform4i(this.virtual_texture_render_pipeline.uniforms.bounds, t_x(tile.tile_x), t_x(tile.tile_x + tile.width), t_y(tile.tile_y), t_y(tile.tile_y + tile.width));
                gl.uniform1ui(this.virtual_texture_render_pipeline.uniforms.index, idx + 1);
                
                gl.drawArrays(gl.TRIANGLES, 0, 6);
            }

            // filling tiles_info_buffer_gpu with the tiles info
            let tiles_info_cpu = new Int32Array(this.max_tiles * 4 * 2);
            for (let i = 0; i < this.tiles_storage_cpu.length; ++i) {
                let tile = this.tiles_storage_cpu[i];
                tiles_info_cpu[i * 4] = tile.tile_x;
                tiles_info_cpu[i * 4 + 1] = tile.tile_y;
                tiles_info_cpu[i * 4 + 2] = tile.width;
            }
            const off = this.max_tiles * 4;
            for (let i = 0; i < this.tiles_storage_cpu_detail.length; ++i) {
                let tile = this.tiles_storage_cpu_detail[i];
                tiles_info_cpu[off + i * 4] = tile.tile_x;
                tiles_info_cpu[off + i * 4 + 1] = tile.tile_y;
                tiles_info_cpu[off + i * 4 + 2] = tile.width;
            }
            gl.bindBuffer(gl.UNIFORM_BUFFER, this.tiles_infos_buffer);
            gl.bufferData(gl.UNIFORM_BUFFER, tiles_info_cpu, gl.DYNAMIC_DRAW);
            gl.bindBuffer(gl.UNIFORM_BUFFER, null);

            // signal updated virtual texture
            this.virtual_texture_rebuilt = true;
        },
        bind_to_shader: function (gl_texture_slot_index, gl_texture_slot_texture, gl_infos_uniform) {
            const gl = this.gl_context;
            gl.activeTexture(gl_texture_slot_index);
            gl.bindTexture(gl.TEXTURE_2D, this.virtual_texture_gpu);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
            gl.bindBufferBase(gl.UNIFORM_BUFFER, gl_infos_uniform, this.tiles_infos_buffer);
            this.tiles_storage_gpu.bind_to_shader(gl_texture_slot_texture);
        },
        /** @param {int} i Index of the element to drop, only removes from tiles_xxx member variables*/
        drop_tile_at_index: function (i, coarse) {
            console.log(`Dropping tile ${this.tiles_storage_cpu[i].image.src} index ${i}`);
            console.log(`State before:`);
            console.log(this.tiles_lookup_table);
            let tiles_storage = coarse ? this.tiles_storage_cpu: this.tiles_storage_cpu_detail;
            let tiles_lookup = coarse ? this.tiles_lookup_table: this.tiles_lookup_table_detail;
            if (i >= tiles_storage.lengh) {
                log.error("tile to drop is not existing");
                return;
            }
            let lookup_table_string = tiles_storage[i].lookup_table_string;
            if (tiles_lookup[lookup_table_string] != i)
                console.error(`Index mismatch for delete: Found index ${tiles_lookup[lookup_table_string]}`);
            // remove from tiles_images
            tiles_storage[i].deleted = true;
            delete tiles_storage[i].image;
            tiles_storage[i] = tiles_storage[tiles_storage.length - 1];
            tiles_lookup[tiles_storage[i].lookup_table_string] = i;
            tiles_storage.pop();
            // remove from tiles_storage
            this.tiles_storage_gpu.drop_tile_at_index(i, coarse);
            // remove from lookup_table
            delete tiles_lookup[lookup_table_string];
            console.log(`State after:`);
            console.log(tiles_lookup);
            // console.info(`CPU: Dropped tile ${i} leaving ${this.tiles_storage_cpu.length} tiles`);
        },
        /** @param {int} n Number of tiles to drop from the tiles_xxx cache */
        drop_least_important_tiles: function (n, coarse) {
            if (!n) {
                const n = coarse ? this.tiles_storage_cpu.length: this.tiles_storage_cpu_detail.length;
                for (let i = n - 1; i >= 0; --i)
                    this.drop_tile_at_index(i, coarse);
            } else {
                // gets for each tile in the cpu cache the priority and sorts it in ascending order
                let tiles = coarse ? this.tiles_storage_cpu: this.tiles_storage_cpu_detail;
                let sorted_prios = tiles.map((x, i) => [x.get_priority(), i]).sort((a, b) => a[0] - b[0]);
                for (let i = 0; i < n && i < sorted_prios.length; ++i)
                    this.drop_tile_at_index(sorted_prios[i][1], coarse);    // get the i-th least important tile and retrieve the index from it
            }
            this.rebuild_virtual_texture();
        },
        /**
         * @brief returns a callback function for image processing after a new tile has loaded
         * The returned function is called on the image object that is loaded and takes care of gpu
         * tiles update
         * @param {int} i Index of the tile in the tile cache (is needed to then access the right image)
         * @returns {function():void} The callback function for the image.onload function 
         */
        image_i_loaded_callback: function (i, org_src) {
            let tile = this.tiles_storage_cpu[i];
            let tiles_storage_gpu = this.tiles_storage_gpu;
            let t = this;
            let tile_width = this.tile_width;
            let tile_height = this.tile_height;
            let image_context = this.image_canvas_context;
            return async function () {
                // convert the image to a ArrayBuffer for further processing (data are always provided as uint8)
                if (tile.deleted || org_src != tile.image.src) {
                    console.error('tile was already deleted');
                    return;
                }
                if (tile.image.width != tile_width || tile.image.height != tile_height)
                    console.error(`Image dimension mismatch, loaded image is not of same dimension ${image.image.width}, ${image.image.height} needed for this virtual texture`);
                image_context.drawImage(tile.image, 0, 0);
                let data = new Uint8Array(image_context.getImageData(0, 0, tile_width, tile_height).data);
                if (tile.deleted) {
                    console.error('tile was already deleted');
                    return;
                }
                tiles_storage_gpu.set_image_data(i, data);
                tile.data_uploaded_to_gpu = true;
                t.rebuild_virtual_texture();
                let r = await Util.check_virtual_texture(t);
                if (!r)
                    console.error(`Oh deary me ${tile.image.src}, ${i}`);
            }
        },
        upload_loaded_images: function () {
            let change = false;
            for (let i = 0; i < this.tiles_storage_cpu.length; ++i) {
                let tile = this.tiles_storage_cpu[i];
                if (!tile.loaded || tile.data_uploaded_to_gpu)
                    continue;
                if (tile.image.width != this.tile_width || tile.image.height != this.tile_height)
                    console.error(`Image dimension mismatch, loaded image is not of same dimension ${image.image.width}, ${image.image.height} needed for this virtual texture`);
                this.image_canvas_context.drawImage(tile.image, 0, 0);
                let data = new Uint8Array(this.image_canvas_context.getImageData(0, 0, this.tile_width, this.tile_height).data.buffer);
                this.tiles_storage_gpu.set_image_data(i, data);
                tile.data_uploaded_to_gpu = true;
                change = true;
                // let r = await Util.check_virtual_texture(t);
                // if (!r)
                //     console.error(`Oh deary me ${tile.image.src}, ${i}`);
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
        length: 0,
        length_detail: 0,
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
        texture_cpu: null,

        // member functions
        /**
         * @param {int} tile_width Tile width in pixels
         * @param {int} tile_height Tile height in pixels
         * @param {int} max_size Max amounts of images internally 2 times as many are stored for detail and coarse
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
                this.max_size * 2,
                0,
                this.texture_type.format,
                this.texture_type.element_type,
                null,
            );
            this.texture_cpu = texture_type.create_new_cpu_buffer(tile_width * tile_height * max_size);
            return this;
        },
        /** 
         * @param {int} n Drops the image color at index n and replaces the data with the data of the last tile, then pops the back 
         * @param {bool} coarse If true then the first 255 images should be considered, else the last 255
         * @note Does not sync the data with the gpu, this has to be done in a call to upload_data_to_gpu
         */
        drop_tile_at_index: function (n, coarse) {
            // swap last image to drop index and the pop (only do if the image is not the last one)
            const length = coarse ? this.length: this.length_detail;
            if (n < length - 1) {
                let bytes_per_image = this.texture_type.bytes_per_element * this.tile_width * this.tile_height;
                let from_pos = (this.length - 1) * bytes_per_image;
                if (!coarse) from_pos += this.max_size * bytes_per_image;
                let data_from = new Uint8Array(this.texture_cpu.buffer, from_pos, bytes_per_image);
                this.set_image_data(n, data_from, coarse);
            }
            this.length -= 1;
            // console.info(`GPU: Dropped tile ${n} leaving ${this.length} tiles`);
        },
        /** 
         * @brief should be used before set_image_data is used to reserver a spot in the tile array 
         * @param {bool} coarse Indicates whether a coarse or detailed tile has to be reserved
         * @return {int} Index which was reserved for the new tile
         */
        reserve_image_tile: function (coarse) {
            if (coarse && this.length >= this.max_size) {
                console.error("set_image_data(): This TilesGpu object is already full, first delete a tile before pushing the image data");
                return;
            }
            if (!coarse && this.length_detail >= this.max_size) {
                console.error("set_image_data(): This TilesGpu object is already full, first delete a detail tile before pushing the image data");
                return;
            }
            return coarse ? this.length++: this.length_detail++;
        },
        /** 
         * @brief Function to set data in the tile image. Automatically uses only the first x bytes from the
         * image to set if eg. the given data is from an rgba image and the stored images are only r images.
         * @param {int} i Index of the image that should be set
         * @param {ArrayBuffer} data Image data, needs to have the same byte size as the internal tile 
         * @param {bool} coarse Indicates if the data is for the coarse data part or for a detail tile
         */
        set_image_data: function (i, data, coarse) {
            console.log(`set_image_data(...) Setting data for image ${i}`);
            const length = coarse ? this.length: this.length_detail;
            if (i >= length) {
                console.error("set_image_data(): Image index to set is out of bounds");
                return;
            }
            const bytes_per_image = this.texture_type.bytes_per_element * this.tile_width * this.tile_height;
            if (data.byteLength != bytes_per_image)
                console.debug("set_image_data(): Image byte size mismatch, will stride through the given data");
            let stride = data.byteLength / bytes_per_image;
            if (1 != stride) {
                console.error("Stride ahs to be one but is " + stride);
                return;
            }
            let t = performance.now();
            const offset = coarse ? 0: this.max_size;
            this.texture_cpu.set(data, (i + offset) * bytes_per_image);
            this.gl_context.bindTexture(this.gl_context.TEXTURE_2D_ARRAY, this.texture_gpu);
            this.gl_context.texSubImage3D(
                this.gl_context.TEXTURE_2D_ARRAY,
                0, 0, 0, i + offset,
                this.tile_width,
                this.tile_height,
                1,
                this.texture_type.format,
                this.texture_type.element_type,
                data
            );
            this.gl_context.bindTexture(this.gl_context.TEXTURE_2D_ARRAY, null);
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
        get_tile_as_base64: function (i) {
            let bytes_per_image = this.texture_type.bytes_per_element * this.tile_width * this.tile_height;
            let binary = '';
            for (let j = 0; j < bytes_per_image; ++j)
                binary += String.fromCharCode(data_view[bytes_per_image * i + i]);
            return window.btoa(binary);
        }
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
        lookup_table_string: "",
        last_use: 0,
        /** @type{Image} */
        image: null,
        loaded: false,
        data_uploaded_to_gpu: false,

        // member functions
        /**
         * @param {string}   tile_url Url from where the data has to be loaded
         * @param {int}      width Width of the tile in amount of tiles
         * @param {int}      tile_x Starting coordinate x in the tile texture (so start of the tile in the most precise level)
         * @param {int}      tile_y Starting coordinate y in the tile texture (so start of the tile in the most precise level)
         * @param {function():void} image_callback Callback that is executed after the tile is loaded
         */
        init: function (tile_url, tile_x, tile_y, width, image_callback) {
            this.width = width;
            this.tile_x = tile_x;
            this.tile_y = tile_y;
            this.lookup_table_string = CoordinateMappings.coords_to_lookup_string(tile_x, tile_y, width);
            this.last_use = Date.now();
            this.image = new Image();
            this.image.crossOrigin = 'anonymous';
            this.image.onload = image_callback;
            this.image.src = tile_url;
            return this;
        },
        /**
         * @returns {float} with a priority value that is the higher the more important this tile is
         */
        get_priority: function () { return -(Date.now() - this.last_use) * priority_time_factor + this.width; },
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

        // member functions
        init: function (x, y, level, url) { this.x = x; this.y = y; this.level = level; this.url = url; return this; },
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
     * @param {int} map_type A value of the MapType enum
     * @return {MapProvider} with functions to make map path lookup easy
     */
    global_coordinate_to_provider: function (lat, lon, map_type) {
        // The function itself simply goes over the providers and picks the first one that covers the coordinates
        // The order of the providers is such that the important providers come first
        switch (map_type) {
            case map_type.height:
                if (MapProviders.height_minifuzi.supports_point(lat, lon))
                    return MapProviders.height_minifuzi;
                return MapProviders.height_row;
            case map_type.satellite:
                if (MapProviders.satellite_bayernatlas.supports_point(lat, lon))
                    return MapProviders.satellite_bayernatlas;
                return MapProviders.satellite_row;
            case map_type.street_view:
                if (MapProviders.street_view_bayernatlas.supports_point(lat, lon))
                    return MapProviders.street_view_bayernatlas;
                return MapProviders.street_view_row;
            case map_type.parcel_borders:
                if (MapProviders.parcel_borders_bayernatlas.supports_point(lat, lon))
                    return MapProviders.parcel_borders_bayernatlas;
        }
        return null;
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
        return canvas.getContext(context_type);
    },

    /**
     * @brief transforms coordinates from wgs_86 to tile index
     * @param {double} lat latitude in degrees nord/south 
     * @param {double} height latitude in degress east/west
     */
    wgs_84_to_tile_idx: function (lat, lon, level) {
        let x = lon * Math.PI / 180;
        let y = Math.asinh(Math.tan(lat * Math.PI / 180));
        let x_ind = Math.floor((1 + (x / Math.PI)) / 2 * (1 << level));
        let y_ind = Math.floor((1 - (y / Math.PI)) / 2 * (1 << level));
        return [x_ind, y_ind];
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

    wgs_84_ddeg_to_m: function (ddeg) {
        return ddeg * this.meter_per_degree;
    },

    glsl_wgs_84_ddeg_to_m: function () {
        return `
        float wgs_84_ddeg_to_m(float ddeg) {
            return ddeg * ${this.meter_per_degree}.;
        }
        `;
    },
    glsl_wgs_84_m_to_ddeg: function () {
        return `
        float wgs_84_m_to_ddeg(float m) {
            return m * ${1 / this.meter_per_degree};
        }
        `;
    },

    glsl_get_tile_index: function () {
        return `
        ivec3 get_tile_index() {
            int mip_offset = 14;
            vec2 dx = dFdx(loc_pos); // .xy * float(1 << 10);
            vec2 dy = dFdy(loc_pos); // .xy * float(1 << 10);
            float max_del = max(dot(dx, dx), dot(dy, dy));
            int level = 15 - clamp(int(.5 * log2(max_del)) + mip_offset, 0, 15);
            // return ivec3(wgs_84_to_tile_idx(world_pos, level), level);
            vec2 uv_glob = wgs_84_to_uv(loc_pos + pos_off);
            return ivec3(ivec2(uv_glob * float(1 << level)), level);
        }
        `;
    },

    glsl_virtual_texture_uniforms: function (v_map_name) {
        return `
        uniform usampler2D virtual_${v_map_name}_index;
        uniform sampler2DArray virtual_${v_map_name};
        uniform Infos_${v_map_name}{ivec4 virtual_${v_map_name}_infos[510];};
        `;
    },

    glsl_virtual_texture_load: function (v_map_name) {
        return `
        vec4 virtual_${v_map_name}_load(vec2 uv_glob) {
            uint index = texture(virtual_${v_map_name}_index, uv_glob).x;
            if (index == 0u)
                return vec4(0);
            // getting offset info etc.
            index -= 1u;
            int offset_x = virtual_${v_map_name}_infos[index].x;
            int offset_y = virtual_${v_map_name}_infos[index].y;
            int width = virtual_${v_map_name}_infos[index].z;
            uv_glob *= vec2(textureSize(virtual_${v_map_name}_index, 0));
            uv_glob -= vec2(offset_x, offset_y);
            uv_glob /= float(width);
            return texture(virtual_${v_map_name}, vec3(uv_glob, float(index)));
        }
        `;
    },

    int32_to_tile_id: function (tiles) {
        const to_obj = (x) => { return { level: (x >>> 24), x: ((x >>> 12) & 0xfff), y: (x & 0xfff) }; };
        return Array.from(tiles, x => to_obj(x));
    },

    execution_break: async function () {
        await new Promise(resolve => setTimeout(resolve, 0));
    },

    check_virtual_texture: async function(tex) {
        const ctx = this.create_canvas_context(tex.tile_width, tex.tile_height);
        // simply go through all textures and see if the table entries and the data is correct
        for(let i = 0; i < tex.tiles_storage_cpu.length; ++i) {
            console.log(`Checking tile at index ${i}`);
            // small sanity checks
            let tile = tex.tiles_storage_cpu[i];
            if (tex.tiles_lookup_table[tile.lookup_table_string] != i) {
                console.error(`tiles_lookup_table index mismatch for tile ${tile.lookup_table_string}, idx ${i}`);
                return false;
            }
            if (!tile.data_uploaded_to_gpu) {
                console.log("skipping due to not yet uploaded");
                continue;
            }
            // check for data consistency
            let img;
            const p = new Promise(resolve => {
                img = new Image();
                img.crossOrigin = "anonymous";
                img.onload = resolve;
                img.src = tile.image.src;
            });
            await p;
            ctx.drawImage(img, 0, 0);
            let data = new Uint8Array(ctx.getImageData(0, 0, tex.tile_width, tex.tile_height).data.buffer);
            let gpu_data = tex.tiles_storage_gpu.texture_cpu;
            let base_offset = data.length * i;
            for (let j = 0; j < data.length; ++j) {
                if (data[j] != gpu_data[base_offset + j]) {
                    console.log(`Data mismatch at image ${i} data index ${j}`);
                    return false;
                }
            }
        }
        console.log("virtual texture check successful");
        return true;
    }
};