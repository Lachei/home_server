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

const Line = () => {return {
    /** 
     * @brief Contains the same as lines_gpu, kept to be able to 
     * quickly access the data on the cpu without readback of gpu */
    lines_cpu: null,
    lines_gpu: null,
    /** 
     * @brief Rendering context from which the lines_gpu buffer was created
     * @type {WebGLRenderingContext} */
    gl: null,

    init: function(gl) {
        
    },
    
}};
