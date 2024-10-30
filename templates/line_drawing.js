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
     * @type {Float32Array}*/
    lines_cpu: null,
    /**
     * @brief Contains the same data as lines_cpu
     */
    lines_gpu: null,
    /**
     * @brief Rendering context from which the lines_gpu buffer was created
     * @type {WebGL2RenderingContext} */
    gl: null,
    /**
     * The lines_cpu and lines_gpu coordinates are given in a local frame
     * with the offset given by this center
     */
    lines_center: null,

    /**
     * @param {WebGL2RenderingContext} gl 
     */
    init: function(gl) {
        this.length = 0;
        const capacity = 10; // default capacity
        this.lines_cpu = new Float32Array(capacity);
        this.lines_gpu = gl.createBuffer();
        this.gl = gl;
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
     * the first line segment is set, but no new line segment is added 
     */
    push: function(e) {
        if (length != 0) // if length is 1 the vertex is only pushed into the second spot of 
            ++length;
        if (length > this.lines_cpu.length) {
            const new_cap = Math.round(this.lines_cpu.length * LINE_CONST.ARRAY_GROWTH_FAC);
            let t = new Float32Array(new_cap);
            t.set(this.lines_cpu);
            this.lines_cpu = t;
        }
        
    },
    push_array: function (a) {

    }
}};
