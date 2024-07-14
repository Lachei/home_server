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
const height_map_type = 0x12392445;
const satellite_map_type = 0x12392446;
const streetview_map_type = 0x12392447;
const tiles_gpu_type = 0x12392448;
const tile_type = 0x12392449;
const tile_request_type = 0x12392450;
const texture_type_type = 0x12392451;
const map_provider_type = 0x12392452;

// const declarations for settings
const tiles_count = 255;
const priority_time_factor = 1.;

const VirtualHeightMap = () => {
    return {
        type: height_map_type,
        // member variables
        tile_width: 0,
        tile_height: 0,
        max_tiles: 0,
        v_tex_height: 0,
        v_tex_width: 0,
        v_tex_extent: { min_lat: 0, max_lat: 0, min_lon: 0, max_lon: 0 },
        /** @type {{key: int}} */
        tiles_lookup_table: {}, // is a lookup table which maps a string containing "{lat}/{lon}/{width}" to an index
        /** @type {TilesGpu} */
        tiles_storage_gpu: null,
        /** @type {Array.<Tile>} */
        tiles_storage_cpu: [],
        virtual_texture_byte_size: 0, // is determined according to the max_tiles parameter
        virtual_texture_rebuilt: false, // used to determine whether view has to be rerendered due to an updated virtual texture cache
        /** @type {ArrayBuffer} */
        virtual_texture_cpu: null,
        /** @type {Texture} */
        virtual_texture_gpu: null,
        /** @type {WebGL2RenderingContext} */
        gl_context: null,

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
        init: function (v_tex_width, v_tex_height, v_tex_extent, tile_width, tile_height, max_tiles, gl_context) {
            this.tile_width = tile_width;
            this.tile_height = tile_height;
            this.max_tiles = max_tiles;
            this.v_tex_width = v_tex_width;
            this.v_tex_height = v_tex_height;
            this.v_tex_extent = v_tex_extent;
            this.tiles_storage_gpu = TilesGpu().init(tile_width, tile_height, max_tiles, gl_context, TextureTypes(gl_context).u8r);
            this.virtual_texture_byte_size = Math.ceil(Math.ceil(Math.log(max_tiles)) / 8); // get the bits required (log2) and then convert them to required bytes
            this.virtual_texture_cpu = new ArrayBuffer(v_tex_width * v_tex_height * self.virtual_texture_byte_size);
            this.virtual_texture_gpu = gl_context.createTexture();
            this.gl_context = gl_context;
            return this;
        },
        /** @param {Array.<TileRequest>} tile_requests Tiles which are needed next frame */
        update_needed_tiles: function (tile_requests) {
            // sorting the tile requests to have the highest detailed images last to guarantee that
            // detail images will have a later time stamp (important for correctly loading the lods)
            tile_requests.sort((a, b) => a.width > b.width);
            for (tile_req of tile_requests) {
                if (tile_req.type != tile_request_type) {// ignore wrong type tiles
                    console.error("Wrong type for tile request, got type: " + String(tile_req.type));
                    continue;
                }

                let lookup_table_string = CoordinateMappings.coords_to_lookup_string(tile_req.lat, tile_req.lon, tile_req.width);
                let already_loaded = lookup_table_string in this.tiles_lookup_table;
                // make space for a new tile if tile cache full
                if (!already_loaded && this.tiles_cpu.length >= tiles_count)
                    this.drop_least_important_tiles(1);
                // add new tile to the storage
                if (!already_loaded) {
                    let i_gpu = this.tiles_storage_gpu.reserve_image_tile();
                    let i_cpu = this.tiles_storage_cpu.length;
                    if (i_gpu != i_cpu)
                        console.error("Added index mismatch for tiles");
                    let map_provider = CoordinateMappings.global_coordinate_to_provider(tile_req.lat, tile_req.lon, MapType.height);
                    let new_tile = Tile().init(
                        map_provider.coords_to_path(tile_req.lat, tile_req.lon, tile_req.width),
                        tile_req.lat,
                        tile_req.lon,
                        tile_req.width,
                        map_provider.virtual_texture_tile_span(tile_req.width),
                        this.image_i_loaded_callback(i_cpu)
                    )
                    this.tiles_storage_cpu.push(new_tile);
                    this.tiles_lookup_table[lookup_table_string] = i_cpu;
                }
                // finally update the last use time
                let i = this.tiles_lookup_table[lookup_table_string];
                this.tiles_storage_cpu[i].last_use = Date.now();
                // the virtual texture is updated when a new image had to be loaded/was loaded (see image_i_loaded_callback)
            }
        },
        /** @brief updates the virtual texture to contain the correct textures stored in the virtual texture cache */
        rebuild_virtual_texture: function () {
            // filling is done by ordering all tiles according to their last use time stamp and then writing them into the cpu buffer first the latest needed textures
            // and then filling the rest of the holes with texels out of the lower quality textures

            if (self.virtual_texture_byte_size != 1 || self.virtual_texture_byte_size != 2) {
                console.error("Only tile_size allowed which can be indexed by at most 2 bytes, currently need " + self.virtual_texture_byte_size + " bytes");
                return;
            }
            const max_index = (1 << (self.virtual_texture_byte_size * 8)) - 1;
            let v_tex_view = self.virtual_texture_byte_size == 1 ? new Uint8Array(self.virtual_texture_cpu) :
                self.virtual_texture_byte_size == 2 ? new Uint16Array(self.virtual_texture_cpu) :
                    new Uint32Array(self.virtual_texture_cpu);

            // filling virtual_texture_cpu -------------------------------------------
            v_tex_view.fill(max_index);
            let ordered_tiles = this.tiles_storage_cpu.map((x, i) => [x.last_use, i]).sort((a, b) => a[0] > b[0]);
            for ([last_use, idx] of ordered_tiles) {
                let tile = this.tiles_cpu[idx];
                if (!tile.data_uploaded_to_gpu) // ignore not uploaded tiles (will be updated later due to callback which calls this function in its final steps)
                    continue;
                let x = tile.tile_x;
                let y = tile.tile_y;
                for (let yy = y; yy < y + t.tile_span; ++y) {
                    for (let xx = x; xx < x + t.tile_span; ++x) {
                        v_tex_view[yy * this.v_tex_width + xx] = idx;
                    }
                }
            }

            // upload virtual texture to gpu -----------------------------------------
            let texture_type = self.virtual_texture_byte_size == 1 ? TextureTypes.u8r :
                TextureTypes.u8rg;
            this.gl_context.bindTexture(this.virtual_texture_gpu);
            this.gl_context.texImage2D(
                this.gl_context.TEXTURE_2D,
                0,
                texture_type.format,
                this.v_tex_width,
                this.v_tex_height,
                0,
                texture_type.format,
                texture_type.element_type,
                self.virtual_texture_cpu
            );

            // signal updated virtual texture
            this.virtual_texture_rebuilt = true;
        },
        bind_virtual_texture_to_shader: function (gl_texture_slot) {
            const gl = this.gl_context;
            gl.activeTexture(gl_texture_slot);
            gl.bindTexture(gl.TEXTURE_2D, this.virtual_texture_gpu);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        },
        /** @param {int} i Index of the element to drop, only removes from tiles_xxx member variables*/
        drop_tile_at_index: function (i) {
            // remove from tiles_images
            this.tiles_storage_cpu[i].onload = () => { };    // resetting the callback function to avoid loading errors when the image was already removed from cache but not yet fully loaded
            this.tiles_storage_cpu[i] = this.tiles_storage_cpu[this.tiles_storage_cpu.length - 1];
            this.tiles_storage_cpu.pop();
            // remove from tiles_storage
            this.tiles_storage.drop_tile_at_index(i);
            // remove from lookup_table
            delete this.tiles_lookup_table[t.lookup_table_string];
        },
        /** @param {int} n Number of tiles to drop from the tiles_xxx cache */
        drop_least_important_tiles: function (n) {
            // gets for each tile in the cpu cache the priority and sorts it in ascending order
            let sorted_prios = this.tiles_cpu.map((x, i) => [x.get_priority(), i]).sort((a, b) => a[0] < b[0]);
            for (let i = 0; i < n && i < sorted_prios.length; ++i)
                this.drop_tile_at_index(sorted_prios[i][1]);    // get the i-th least important tile and retrieve the index from it
        },
        /**
         * @brief returns a callback function for image processing after a new tile has loaded
         * The returned function is called on the image object that is loaded and takes care of gpu
         * tiles update
         * @param {int} i Index of the tile in the tile cache (is needed to then access the right image)
         * @returns {function():void} The callback function for the image.onload function 
         */
        image_i_loaded_callback: function (i) {
            let tiles_storage_cpu = this.tiles_storage_cpu;
            let tiles_storage_gpu = this.tiles_storage_gpu;
            let rebuild_virtual_texture = this.rebuild_virtual_texture;
            return function () {
                // convert the image to a ArrayBuffer for further processing (data are always provided as uint8)
                let image = tiles_storage_cpu[i];
                let context = Util.create_canvas_context(image.width, image.height);
                context.drawImage(image, 0, 0);
                let data = new ArrayBuffer(context.getImageData(0, 0, image.width, image.height).data.buffer);
                tiles_storage_gpu.set_image_data(i, data);
                tiles_storage_gpu.upload_data_to_gpu();
                image.data_uploaded_to_gpu = true;
                rebuild_virtual_texture();
            }
        }
    };
};

const VirtualSatelliteMap = () => {
    return {
        type: satellite_map_type,
        // member variables

        // member functions
    };
};

const VirtualStreetviewMap = () => {
    return {
        type: streetview_map_type,

        // member variables

        // member functions
    };
};

/**
 * @brief helper object to get different gpu and cpu buffer for different texture types along with
 * the correct formats
 * @param {WebGL2RenderingContext} gl WebGL rendering context
 */
const TextureTypes = (gl) => {
    return {
        u8r: {
            type: texture_type_type,
            bytes_per_element: 1,
            format: gl.R8,
            element_type: gl.UNSIGNED_BYTE,
            create_new_cpu_buffer: function (n) { return new Int8Array(n); },
        },
        u8rg: {
            type: texture_type_type,
            bytes_per_element: 2,
            format: gl.RG8,
            element_type: gl.UNSIGNED_BYTE,
            create_new_cpu_buffer: function (n) { return new Int8Array(n); },
        },
        u8rgba: {
            type: texture_type_type,
            bytes_per_element: 4,
            format: gl.RGBA8,
            element_type: gl.UNSIGNED_BYTE,
            create_new_cpu_buffer: function (n) { return new Int8Array(4 * n); },
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
         * @param {int} max_size Max amounts of images
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
            this.texture_cpu = texture_type.create_new_cpu_buffer(tile_width * tile_height * max_size);
            return this;
        },
        /** 
         * @param {int} n Drops the image color at index n and replaces the data with the data of the last tile, then pops the back 
         * @note Does not sync the data with the gpu, this has to be done in a call to upload_data_to_gpu
         */
        drop_tile_at_index: function (n) {
            // just pop and return if nothing has to be copied
            if (this.length <= 1) {
                this.length = 0;
                return;
            }
            // else swap last image to drop index and the pop
            let data_view = new Uint8Array(this.texture_cpu);
            let bytes_per_image = this.texture_type.bytes_per_element * this.tile_width * this.tile_height;
            let to_pos = n * bytes_per_image;
            let from_pos = (length - 1) * bytes_per_image;
            for (let i = 0; i < bytes_per_image; ++i)
                data_view[to_pos + i] = data_view[from_pos + i];
            this.length -= 1;
        },
        /** 
         * @brief should be used before set_image_data is used to reserver a spot in the tile array 
         * @return {int} Index which was reserved for the new tile
         */
        reserve_image_tile: function () {
            if (this.length >= this.max_size) {
                console.error("set_image_data(): This TilesGpu object is already full, first delete a tile before pushing the image data");
                return;
            }
            return this.length++;
        },
        /** 
         * @brief Function to set data in the tile image. Automatically uses only the first x bytes from the
         * image to set if eg. the given data is from an rgba image and the stored images are only r images.
         * @param {int} i Index of the image that should be set
         * @param {ArrayBuffer} data Image data, needs to have the same byte size as the internal tile 
         */
        set_image_data: function (i, data) {
            if (i >= this.length) {
                console.error("set_image_data(): Image index to set is out of bounds");
                return;
            }
            let bytes_per_image = this.texture_type.bytes_per_element * this.tile_width * this.tile_height;
            if (data.byteLength != bytes_per_image)
                console.warning("set_image_data(): Image byte size mismatch, will stride through the given data");
            let stride = data.byteLength / bytes_per_image;
            if (Math.floor(stride) != stride) {
                console.error("Stride could not be deduces -> stride is not a whole number " + String(stride));
                return;
            }
            let pos = i * bytes_per_image;
            let bpe = this.texture_type.bytes_per_element;
            const data_view = new Uint8Array(data);
            const internal_view = new Uint8Array(this.tiles_cpu);
            for (let i = 0; i < this.tile_width * this.tile_height; ++i)
                for (let b = 0; b < bpe; ++b)
                    internal_view[pos + i * bpe + b] = data_view[i * stride * bpe + b];
        },
        /** @brief syncs the cpu data with the gpu data */
        upload_data_to_gpu: function () {
            this.gl_context.bindTexture(this.texture_gpu);
            this.gl_context.texImage3D(
                this.gl_context.TEXTURE_2D_ARRAY,
                0,
                this.texture_type.format,
                this.tile_width,
                this.tile_height,
                this.max_size,
                0,
                this.texture_type.format,
                this.texture_type.element_type,
                this.texture_cpu
            );
        },
        bind_texture_to_shader: function (gl_texture_slot) {
            const gl = this.gl_context;
            gl.activeTexture(gl_texture_slot);
            gl.bindTexture(gl.TEXTURE_2D_ARRAY, this.texture_gpu);
            gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
            gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
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
        lat: 0,
        lon: 0,
        width: 0,
        tile_x: 0,
        tile_y: 0,
        tile_span: 0,           /** @brief describes how many tiles the virtual texture this tile spans */
        lookup_table_string: "",
        last_use: 0,
        /** @type{Image} */
        image: null,
        data_uploaded_to_gpu: false,

        // member functions
        /**
         * @param {string}   tile_url Url from where the data has to be loaded
         * @param {int}      min_lat min latitude of the tile
         * @param {int}      max_lat max latitude of the tile
         * @param {int}      width Width of the tile in meters
         * @param {int}      tile_x Starting coordinate x in the tile texture (so start of the tile in the most precise level)
         * @param {int}      tile_y Starting coordinate y in the tile texture (so start of the tile in the most precise level)
         * @param {int}      tile_span Width of the
         * @param {function():void} image_callback Callback that is executed after the tile is loaded
         */
        init: function (tile_url, min_lat, min_lon, width, tile_x, tile_y, tile_span, image_callback) {
            this.lat = min_lat;
            this.lon = min_lon;
            this.width = width;
            this.tile_x = tile_x;
            this.tile_y = tile_y;
            this.tile_span = tile_span;
            this.lookup_table_string = CoordinateMappings.coords_to_lookup_string(min_lat, min_lon, width);
            this.last_use = Date.now();
            this.image = new Image();
            this.image.src = tile_url;
            this.image.onload = image_callback;
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
        lat: 0,
        lon: 0,
        width: 0,
        url: "",

        // member functions
        init: function (lat, lon, width, url) { this.lat = lat; this.lon = lon; this.width = width; this.url = url; return this; },
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
     * @param {int} lat 
     * @param {int} lon 
     * @param {int} width 
     * @returns {String} containing the input parameters concatenated via /
     */
    coords_to_lookup_string: function (lat, lon, width) {
        return String(lat) + "/" + String(lon) + "/" + String(width);
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
    /**
     * @brief Create the glsl function in string form to be included in the glsl source
     * @return {string} With the conversion function containing
     */
    glsl_wgs_84_to_tile_idx: function () {
        return `
        ivec2 wgs_84_to_tile_idx(vec2 wold_pos, int level) {
            float x = world_pos.y * PI / 180.;
            float y = asinh(tan(world_pos.x * PI / 180.));
            float l = float(1 << level);
            return ivec2(int((1.0 + (x / PI)) / 2. * l),
                        int((1.0 - (y / PI)) / 2. * l));
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
    
    glsl_wgs_84_ddeg_to_m: function() {
        return `
        float wgs_84_ddeg_to_m(float ddeg) {
            return ddeg * ${this.meter_per_degree}.;
        }
        `;
    },
};