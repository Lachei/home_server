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
    ARRAY_GROWTH_FAC: 1.5
};

const Line = () => {return {
    /** 
     * @brief contains the amount of LINES. The length of lines_cpu and gpu is
     * not the correct length as they contain some already reserved space
     * to get amortized linear runtime when doing a push of a vertex
     */
    length: 0,
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
    cpu_gpu_synced: false,
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
        this.cpu_gpu_synced = false;
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
        this.cpu_gpu_synced = false;
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
        this.cpu_gpu_synced = false;
        const [x, y] = this.lat_lon_to_xy(lat, lon);
        this.lines_cpu[idx * 2] = x;
        this.lines_cpu[idx * 2 + 1] = y;
    },
    remove_point: function(idx) {
        this.cpu_gpu_synced = false;
        this.lines_cpu = this.lines_cpu.filter((_, i) => i != idx);
    },
    sync_with_gpu: function() {
        if (this.cpu_gpu_synced)
            return;
        
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
    },
    draw: function() {
        // draw a box for each pair of coordinates (keep in mind that each vertex is only stored 
        // once so each inner vertex of the line has to be drawn twice, can be achieved with the
        // correct stride for the instanced rendering)
        if (!this.cpu_gpu_synced) {
            console.error("Line points not synced with gpu, skipping draw");
            return;
        }
        let gl = this.gl;
    }
}};
