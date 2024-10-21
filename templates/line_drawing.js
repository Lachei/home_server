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
 */

