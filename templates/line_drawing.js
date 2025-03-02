/**
 * @doc Utility to render lines efficiently on a pre pre-rendered 3d surfaces
 * 
 * The pre-rendered 3d surface is only required to provide a 3d depth map, the
 * accompanying inverse projection matrix (Thus being able to get from clip space
 * to view space)
 * 
 * The line rendering itself is done by doing indexed rendering over line-boxes.
 * Line boxes are simply boxes which have the xy-footprint of the normal line
 * and go from -1 km to 8 km height (should maybe be a bit lower for deep sea stuff...).
 * 
 * For each fragment created it is checked with the depth value if the reconstructed 3d
 * view space position lies close enough to the line center (simply needs a )
 * 
 * The lines are drawn with instanced rendering to 1. be able to draw a whole box for each line
 * (This is in the end the bounding box of the maximal visible area) and for each of the
 * boxes have the start and end position correctly displayed.
 * Even though we need to store each interior point of the line (Each point with more than 1 adjacent
 * points) 2 times (once for the line before, once for the line after) this should over all give the
 * bonus of being able to truly have a variable length line combined with a uniform way of drawing
 * the whole line strip. 
 * 
 * The start and end position of the line are stored as vec4 (2 components for
 * start, 2 components for the end) and in floating point precision. These coordinates are
 * however in a "local" coordinates frame which is centered around the midpoint fo all line
 * points (calculated as the mean of all points)
 * This is done as otherwise the precision of the coordinates is not high enough to faithfully
 * represent small deviations on world scale.
 * 
 * In the shader itself the center offset is used with the camera-view offset to align the
 * local coordinate frame of the lines with the view space. This also automatically solves
 * the float precision problem on world scale
 */

/** @brief Constants for the Lines library */
const LINE_CONST = {
    ARRAY_GROWTH_FAC: 1.5,
    CUR_ID: 0,
};

const Line = () => {return {
    /** 
     * @brief contains the amount of LINES. The length of lines_cpu and gpu is
     * not the correct length as they contain some already reserved space
     * to get amortized linear runtime when doing a push of a vertex
     */
    length: 0,
    /**
     * @brief The version is used to check if a requested tile has to be updated from cache
     * The id is incremented each time the data is changed. (This also means that external changes
     * have to adapt the id to trigger a rerendering)
     */
    version: 0,
    /** 
     * @brief Contains the same as lines_gpu, kept to be able to 
     * quickly access the data on the cpu without readback of gpu 
     * @note Internal points in here are always only stored once,
     * and the points are stored in x/y (tile space) coords instead of
     * lat/lon coords (avoids additional computation on gpu)
     * @type {Float64Array}*/
    lines_cpu: null,
    /**
     * @brief Contains the same data as lines_cpu but offset to the the calculated
     * center of the gpx track.
     * First 2 elements of the array are the average position
     * @type {WebGLBuffer}
     */
    lines_gpu: null,
    gpu_version: -1,
    lines_center: {x: 0, y: 0},
    /**
     * @brief Rendering context from which the lines_gpu buffer was created
     * @type {WebGL2RenderingContext} */
    gl: null,
    lat_lon_to_xy: null,

    /**
     * @param {WebGL2RenderingContext} gl 
     * @param {function(double, double) -> (double, double)} lat_lon_to_xy function to convert from
     * lat lon coordinates to x/y map coordinates
     */
    init: function(gl, lat_lon_to_xy) {
        this.length = 0;
        const capacity = 10; // default capacity
        this.lines_cpu = new Float64Array(capacity * 2);
        this.lines_gpu = gl.createBuffer();
        this.gl = gl;
        this.lat_lon_to_xy = lat_lon_to_xy;
        return this;
    },
    /**
     * @brief relives the webgl buffer and should be always called to avoid
     * gpu memory buffer 'leaks'
     */
    deinit: function() {
        this.gl.deleteBuffer(this.lines_gpu);
    },
    /** 
     * @brief Push vertices to the back of the line, if this is the first vertex only
     * the first line segment is set, but no new line segment is added.
     * Grows capacity of buffers exponential to avoid constant resizes (amortized constant growth rate)
     * @param [lat, lon] 
     */
    push: function(e) {
        this.version++;
        const p = this.length++;
        if (this.length * 2 > this.lines_cpu.length) {
            const new_cap = Math.round(this.lines_cpu.length * LINE_CONST.ARRAY_GROWTH_FAC);
            let t = new Float64Array(new_cap);
            t.set(this.lines_cpu);
            this.lines_cpu = t;
        }
        const [x, y] = this.lat_lon_to_xy(e.lat, e.lon);
        this.lines_cpu[p * 2] = x;
        this.lines_cpu[p * 2 + 1] = y;
    },
    /**
     * Adds an array of points with [lat1, lon1, ..., latn, lonn]
     * @param {Array<float>} a 
     */
    push_array: function (a) {
        this.version++;
        const p = this.length;
        this.length += a.length / 2;
        if (this.length * 2 > this.lines_cpu.length) {
            let cap = this.lines_cpu.length / 2;
            for (; cap < this.length; cap = Math.round(cap * LINE_CONST.ARRAY_GROWTH_FAC));
            let t = new Float64Array(new_cap);
            t.set(this.lines_cpu);
            this.lines_cpu = t;
        }
        for (let i = 0; i < a.length / 2; ++i) {
            const [x, y] = this.lat_lon_to_xy(a[i * 2], a[i * 2 + 1]);
            this.lines_cpu[p + i * 2] = x;
            this.lines_cpu[p + i * 2 + 1] = y;
        }
    },
    set_point_coords: function(idx, lat, lon) {
        this.version++;
        const [x, y] = this.lat_lon_to_xy(lat, lon);
        this.lines_cpu[idx * 2] = x;
        this.lines_cpu[idx * 2 + 1] = y;
    },
    remove_point: function(idx) {
        this.version++;
        this.lines_cpu = this.lines_cpu.filter((_, i) => i != idx);
    },
    sync_with_gpu: function() {
        if (this.version == this.version_gpu)
            return;
        
        this.version_gpu = version;
        
        // 2 way pass to 1. find mean, 2. calc offset positions
        let m_x = .0;
        let m_y = .0;
        for (let i = 0; i < this.lines_cpu.length / 2; ++i) {
            m_x += this.lines_cpu[i * 2];
            m_y += this.lines_cpu[i * 2 + 1];
        }
        m_x /= this.lines_cpu.length / 2;
        m_y /= this.lines_cpu.length / 2;
        this.lines_center.x = m_x;
        this.lines_center.y = m_y;
        let upload_buf = new Float64Array(lines_cpu.length);
        for (let i = 0; i < this.lines_cpu.length/ 2; ++i) {
            upload_buf[i * 2] = this.lines_cpu[i * 2] - m_x;
            upload_buf[i * 2 + 1] = this.lines_cpu[i * 2 + 1] - m_y;
        }

        this.gl.bindBuffer(this.gl.ARRAY_BUFFER, this.lines_gpu);
        this.gl.bufferData(this.gl.ARRAY_BUFFER, this.upload_buf, this.gl.DYNAMIC_DRAW);
        this.gl.bindBuffer(this.gl.ARRAY_BUFFER, null);
        this.cpu_gpu_synced = true;
    }
}};

// the line renderer provides drawing pipelines which render the given line to a given image in blend over mode
// and copies the result back to the image given (image here is a webgl texture and not an html image)
// The result of the rendering itself is never cached because the overdrawing of lines into the webgl texture
// has to be done anyways (either through the 2dContext via drawImage or like this) and thus removing the cache
// textures should overall increase performance while requiring only a minor change of the setup
// It is however of course important to note that html images that should be overdrawn have to be reuploaded
// before the line drawing, because otherwise the line stacking will occur.
// 
// The drawing is done by binding the array texture with all loaded textures to the drawing pipeline,
// then drawing the line for the current tile (does load and blend colors from the array texture in teh fragment shader) and finally
// copies the contents of the temporary tile buffer to the array texture at the correct spot
const LineRenderer = () => {
    return {
        // variables
        
        gl: null,
        tile_width: 0,
        tile_height: 0,
        tile_texture: null,
        tile_framebuffer: null,
        gpu_pipeline: null,
        gpu_uniforms: null,

        // functions
        
        init: function(gl_context, tile_width = 256, tile_height = 256) {
            this.gl = gl_context;
            this.tile_width = tile_width;
            this.tile_height = tile_height;
            // creating the temporary tile framebuffer and texture
            this.tile_texture = gl_context.createTexture();
            gl_context.bindTexture(this.tile_texture);
            gl_context.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, tile_width, tile_height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
            this.tile_framebuffer = gl_context.createFramebuffer();
            gl_context.bindFramebuffer(this.tile_framebuffer);
            gl_context.framebufferTexture2D(gl_context.FRAMEBUFFER, gl__context.COLORo_ATTACHMENT0, gl_context.TEXTURE_2D, this.tile_texture, 0);

            // guarantee no sideeffects for the internal texture and framebuffer after this function
            gl_context.bindTexture(null);
            gl_context.bindFramebuffer(null);
            
            // creating the shaders and the final rendering pipeline (requires previous loading of the main script which contains the initShaderProgram code)
            // **Note**: All coordinates in the following are already normalized to coordinates in the range [0,1]
            // for the whole intire world, where 0.5 is the normal longitude of 0° going through Greenich, UK
            this.gpu_pipeline = initShaderProgram(gl_context,
                /** Vertex Shader */
                `#version 300 es
                uniform vec2 base_pos; // center pos of the lines, as sum with the lines gives the true coordinate
                uniform vec4 bounds; // contains in xy the min xy, and in zw the width xy
                
                attribute vec2 rel_pos; // relative position which can be converted to global position by summation with base_pos

                void main() {
                  vec2 base_diff = base_pos - bounds.xy;  // By subtacting the coarse positions first high fidelity is kept for the detail position
                  // final relative position calculation for this field
                  // Note that the final position has to be in normalized device coordinates with range [-1,1], and has to 
                  // account for the tile bounds (the min bound was already accounted for by subtracting it from the base_pos
                  // -> only missing scaling to width of tile)
                  vec2 pos = base_diff + rel_pos; 
                  pos /= bounds.zw; // normalized to [0,1];
                  pos = pos * 2. - 1.;
                  gl_Position = vec4(pos, .5, 1.);
                }`,
                /** Fragment Shader */
                `#version 300 es
                uniform sampler2DArray tiles;
                uniform int index;
                uniform vec4 line_col;

                out vec4 col;
                void main() {
                    vec4 prev_col = sample(texelFetch, ivec3(gl_FragCoord.xy, index), 0);
                    col = mix(line_col, prev_col, 1. - line_col.a);
                }`);
            this.gpu_uniforms = {
                program: pipeline,
                attributes: {
                    rel_pos: gl_context.getAttribLocation(pipeline, "rel_pos"),
                },
                uniforms: {
                    base_pos: gl_context.getUniformLocation(pipeline, "base_pos"),
                    bounds: gl_context.getUniformLocation(pipeline, "bounds"),
                    tiles: gl_context.getUniformLocation(pipeline, "tiles"),
                    index: gl_context.getUniformLocation(pipeline, "index"),
                    line_col: gl_context.getUniformLocation(pipeline, "line_col"),
                }
            };
        },
        /** 
         * @brief draw a line for the specified tile_reqests
         * @param line The Line to draw (has to be constructed from the Line in this file to contain the necessary gpu attributes)
         * @param virtual_texture The virtual texture the line should be drawn to
         * @param tiles_to_update An array of indices of the tiles that should be updated/where the lines should be drawn.
         * As also the level (coarse/detail) has to be added the first value of the tuple does indicate just that
         */ 
        draw_line: function(line, virtual_texture, tiles_to_update) {
            if (this.gl != line.gl) {
                console.error("Different webgl contexts are not allowed");
                return;
            }
            for (let [tile_lvl, tile_idx] of tiles_to_update) {
                if (tile_idx >= virtual_texture.max_tiles) {
                    console.warn(`Tile idx ${tile_idx} is out of range of virtual texture (max ${virtual_texture.max_tiles}), ignore`);
                    continue;
                }
                // tile_lvl 0 indicates coarse level
                const w = virtual_texture.v_tex_width - 1; // -1 to get normalized values
                const cpu_tile = tile_level == 0 ? virtual_texture.tiles_storage_cpu[index]: virtual_texture.tiles_storage_cpu_detail[index];
                const gpu_tiles_offset = tile_level == 0 ? virtual_texture.max_tiles: 0;
                
                gpu_tiles.bind_to_shader(this.gl.TEXTURE0);
                this.gl.uniform1i(this.gpu_uniforms.tiles, this.gl.TEXTURE0);
                this.gl.uniform2f(this.gpu_uniforms.base_pos, line.lines_center.x , line.lines_center.y);
                this.gl.uniform2f(this.gpu_uniforms.bounds, cpu_tile.tile_x / w, cpu_tile.tile_w / w, cpu_tile.width / w, cpu_tile.width / w);
                this.gl.uniform1i(this.gpu_uniforms.index, gpu_tiles_offset + index);
                this.gl.uniform4f(this.gpu_uniforms.lines_col, 1, 0, 0, 1);
                this.gl.bindFramebuffer(this.gl.FRAMEBUFFER, this.tile_framebuffer);
                this.gl.disable(this.gl.DEPTH_TEST);
                this.gl.useProgram(this.gl.gpu_pipeline);
                this.gl.vertexAttribPointer(this.gl.uniforms.attributes.rel_pos, 2, this.gl.FLOAT, false, 0, 0);
                this.gl.drawArrays(this.gl.LINES, 0, line.length / 2);
            }
        }
    };
}

const test_line = (gl, lat_lon_to_x) => {
    return Line().init(gl, lat_lon_to_xy).push_array([51.772467159403874, 9.9486005114254, 45.50129841145763, -0.6359689547077347, 45.58217099609847, 22.496126496732316]);
}
