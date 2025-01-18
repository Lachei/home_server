/**
 * Linear algebra helper functions
 * 
 * The functions are mainly focused on 4x4 matrix calculus
 * 
 * The coordinate system is a left-handed system which has in 3D the x-y plane as "ground plane"
 * and z as height system
 * 
 * In screen space the origin is in the left upper corner of the screen where the x-y plane corresponds
 * to the screen plane and the z coordinate is the screen depth
 */

/**
 * Linalg types used here to have a very reliable and easy way to check object type
 */
const LinalgObjTypes = {
    Mat: 0,
};

/**
 * A function creating a Mat4 object base which is not filled with anything
 * All other creation functionalities use this as base to do all operations
 * 
 * The storage format is column major to be directly opengl compatible (https://stackoverflow.com/a/4361018)
 * The internal storage is in double precision for higher fidelity
 */
const MatBaseObject = (rows = 4, cols = 4) => {
    return {
        type: LinalgObjTypes.Mat,
        rows: rows,
        cols: cols,
        entries: Array(rows * cols),
        el_idx: function (row, col) { return row + col * this.rows; },
        at: function (row, col) { return this.entries[this.el_idx(row, col)]; },
        x: function () { return this.entries[0]; },
        y: function () { return this.entries[1]; },
        z: function () { return this.entries[2]; },
        w: function () { return this.entries[3]; },
        is_vec: function (len = 4) { return this.rows == len && this.cols == 1; },
        is_vec_t: function (len = 4) { return this.rows == 1 && this.cols == len; },
        is_absolute_vec: function (len = 4) { return this.is_vec(len) && this.entries[len - 1] == 1; },
        is_relative_vec: function (len = 4) { return this.is_vec(len) && this.entries[len - 1] == 0; },
        to_absolute_vec: function () { this.entries[this.entries.length - 1] = 1; return this; },
        to_relative_vec: function () { this.entries[this.entries.length - 1] = 0; return this; },
        // matrix matrix multiplication with return of a copied matrix
        multiply: function (o) {
            if (typeof o === "number") {
                let ret = MatBaseObject(this.rows, this.cols);
                for (let i = 0; i < ret.entries.length; ++i)
                    ret.entries[i] = this.entries[i] * o;
                return ret;
            }
            if (this.cols != o.rows)
                throw Error(`Can not multiply matrices of shape (${this.rows},${this.cols}) and shape (${o.rows},${o.cols})`);
            let ret = MatBaseObject(this.rows, o.cols);
            ret.entries.fill(0);
            for (let i = 0; i < this.rows; ++i)
                for (let j = 0; j < o.cols; ++j)
                    for (let c = 0; c < this.cols; ++c)
                        ret.entries[ret.el_idx(i, j)] += this.at(i, c) * o.at(c, j);
            return ret;
        },
        // matrix matrix multiplication in place
        mul: function (o) {
            if (typeof o === "number") {
                for (let i = 0; i < this.entries.length; ++i)
                    this.entries[i] *= o;
                return this;
            }
            let tmp = this.multiply(o);
            this.rows = tmp.rows;
            this.cols = tmp.cols;
            this.entries = tmp.entries;
            return this; // returning this to allow chaining of calls: Translate(...).mul(Rotate(...)).mul(Scale(...))
        },
        addition: function (o) {
            if (this.cols != o.cols || this.rows != o.rows)
                throw Error(`Can not add matrices of shape (${this.rows},${this.cols}) and shape (${o.rows},${o.cols})`);
            let ret = MatBaseObject(this.rows, this.cols);
            for (let i = 0; i < this.entries.length; ++i)
                ret.entries[i] = this.entries[i] + o.entries[i];
            return ret;
        },
        add: function (o) {
            if (this.cols != o.cols || this.rows != o.rows)
                throw Error(`Can not add matrices of shape (${this.rows},${this.cols}) and shape (${o.rows},${o.cols})`);
            for (let i = 0; i < this.entries.length; ++i)
                this.entries[i] += o.entries[i];
            return this; // returning this to allow for chaining
        },
        subtract: function (o) {
            if (this.cols != o.cols || this.rows != o.rows)
                throw Error(`Can not subtract matrices of shape (${this.rows},${this.cols}) and shape (${o.rows},${o.cols})`);
            let ret = MatBaseObject(this.rows, this.cols);
            for (let i = 0; i < this.entries.length; ++i)
                ret.entries[i] = this.entries[i] - o.entries[i];
            return ret;
        },
        sub: function (o) {
            if (this.cols != o.cols || this.rows != o.rows)
                throw Error(`Can not subtract matrices of shape (${this.rows},${this.cols}) and shape (${o.rows},${o.cols})`);
            for (let i = 0; i < this.entries.length; ++i)
                this.entries[i] -= o.entries[i];
            return this; // returning this to allow for chaining
        },
        normalize: function () {
            let len = 0;
            this.entries.forEach(x => len += (x * x));
            len = Math.sqrt(len);
            this.entries.forEach((x, i) => this.entries[i] /= len);
            return this;
        },
        normalized: function () {
            let ret = MatBaseObject(this.rows, this.cols);
            ret.entries = [...this.entries];
            return ret.normalize();
        },
        transpose: function () {
            let ret = MatBaseObject(this.cols, this.rows);
            for (let row = 0; row < this.rows; ++row)
                for (let col = 0; col < this.cols; ++col)
                    ret.entries[ret.el_idx(col, row)] = this.at(row, col);
            return ret;
        },
        t: function () {
            let tmp = this.transpose();
            this.rows = tmp.rows;
            this.cols = tmp.cols;
            this.entries = tmp.entries;
            return this;
        },
        // assumes that every vector is in homogenous space (so the last item in the vector is ignored)
        cross: function (o) {
            if (!this.is_vec() || !o.is_vec())
                throw Error('Only vectors supported for the cross function');
            if (this.rows != o.rows)
                throw Error('Vectors need to have the same dimensionality for a cross product');
            let ret = MatBaseObject(this.rows, 1);
            let dim = this.rows - 1;
            let offset = dim - 2;
            for (let i = 0; i < dim; ++i) {
                ret.entries[i] = this.entries[(offset + i) % dim] * o.entries[(offset + 1 + i) % dim] -
                                 this.entries[(offset + 1 + i) % dim] * o.entries[(offset + i) % dim];
            }
            ret.entries[dim] = 0; // is set to 0 to avoid changing the length of the vector
            return ret;
        },
        equals: function (o) {
            if (this.rows != o.rows || this.cols != o.cols)
                return false;
            let all_equal = true;
            this.entries.forEach((e, i) => all_equal &= e == o.entries[i]);
            return all_equal;
        },
        morph: function (o, a) {
            if (this.rows != o.rows || this.cols != o.cols)
                throw Error('Only Matrices of same shape are possible');
            let m = MatBaseObject(this.rows, this.cols);
            this.entries.forEach((e, i) => m.entries[i] = (1 - a) * e + a * o.entries[i]);
            return m;
        },
        inverse: function () {
            if (this.rows != 4 || this.cols != 4)
                throw Error('Current implementation only supports inversion of 4x4 matrices');
            let inv = MatBaseObject(this.rows, this.cols);
            inv.entries[0] = this.entries[5]  * this.entries[10] * this.entries[15] - 
                     this.entries[5]  * this.entries[11] * this.entries[14] - 
                     this.entries[9]  * this.entries[6]  * this.entries[15] + 
                     this.entries[9]  * this.entries[7]  * this.entries[14] +
                     this.entries[13] * this.entries[6]  * this.entries[11] - 
                     this.entries[13] * this.entries[7]  * this.entries[10];

            inv.entries[4] = -this.entries[4]  * this.entries[10] * this.entries[15] + 
                      this.entries[4]  * this.entries[11] * this.entries[14] + 
                      this.entries[8]  * this.entries[6]  * this.entries[15] - 
                      this.entries[8]  * this.entries[7]  * this.entries[14] - 
                      this.entries[12] * this.entries[6]  * this.entries[11] + 
                      this.entries[12] * this.entries[7]  * this.entries[10];

            inv.entries[8] = this.entries[4]  * this.entries[9] * this.entries[15] - 
                     this.entries[4]  * this.entries[11] * this.entries[13] - 
                     this.entries[8]  * this.entries[5] * this.entries[15] + 
                     this.entries[8]  * this.entries[7] * this.entries[13] + 
                     this.entries[12] * this.entries[5] * this.entries[11] - 
                     this.entries[12] * this.entries[7] * this.entries[9];

            inv.entries[12] = -this.entries[4]  * this.entries[9] * this.entries[14] + 
                       this.entries[4]  * this.entries[10] * this.entries[13] +
                       this.entries[8]  * this.entries[5] * this.entries[14] - 
                       this.entries[8]  * this.entries[6] * this.entries[13] - 
                       this.entries[12] * this.entries[5] * this.entries[10] + 
                       this.entries[12] * this.entries[6] * this.entries[9];

            inv.entries[1] = -this.entries[1]  * this.entries[10] * this.entries[15] + 
                      this.entries[1]  * this.entries[11] * this.entries[14] + 
                      this.entries[9]  * this.entries[2] * this.entries[15] - 
                      this.entries[9]  * this.entries[3] * this.entries[14] - 
                      this.entries[13] * this.entries[2] * this.entries[11] + 
                      this.entries[13] * this.entries[3] * this.entries[10];

            inv.entries[5] = this.entries[0]  * this.entries[10] * this.entries[15] - 
                     this.entries[0]  * this.entries[11] * this.entries[14] - 
                     this.entries[8]  * this.entries[2] * this.entries[15] + 
                     this.entries[8]  * this.entries[3] * this.entries[14] + 
                     this.entries[12] * this.entries[2] * this.entries[11] - 
                     this.entries[12] * this.entries[3] * this.entries[10];

            inv.entries[9] = -this.entries[0]  * this.entries[9] * this.entries[15] + 
                      this.entries[0]  * this.entries[11] * this.entries[13] + 
                      this.entries[8]  * this.entries[1] * this.entries[15] - 
                      this.entries[8]  * this.entries[3] * this.entries[13] - 
                      this.entries[12] * this.entries[1] * this.entries[11] + 
                      this.entries[12] * this.entries[3] * this.entries[9];

            inv.entries[13] = this.entries[0]  * this.entries[9] * this.entries[14] - 
                      this.entries[0]  * this.entries[10] * this.entries[13] - 
                      this.entries[8]  * this.entries[1] * this.entries[14] + 
                      this.entries[8]  * this.entries[2] * this.entries[13] + 
                      this.entries[12] * this.entries[1] * this.entries[10] - 
                      this.entries[12] * this.entries[2] * this.entries[9];

            inv.entries[2] = this.entries[1]  * this.entries[6] * this.entries[15] - 
                     this.entries[1]  * this.entries[7] * this.entries[14] - 
                     this.entries[5]  * this.entries[2] * this.entries[15] + 
                     this.entries[5]  * this.entries[3] * this.entries[14] + 
                     this.entries[13] * this.entries[2] * this.entries[7] - 
                     this.entries[13] * this.entries[3] * this.entries[6];

            inv.entries[6] = -this.entries[0]  * this.entries[6] * this.entries[15] + 
                      this.entries[0]  * this.entries[7] * this.entries[14] + 
                      this.entries[4]  * this.entries[2] * this.entries[15] - 
                      this.entries[4]  * this.entries[3] * this.entries[14] - 
                      this.entries[12] * this.entries[2] * this.entries[7] + 
                      this.entries[12] * this.entries[3] * this.entries[6];

            inv.entries[10] = this.entries[0]  * this.entries[5] * this.entries[15] - 
                      this.entries[0]  * this.entries[7] * this.entries[13] - 
                      this.entries[4]  * this.entries[1] * this.entries[15] + 
                      this.entries[4]  * this.entries[3] * this.entries[13] + 
                      this.entries[12] * this.entries[1] * this.entries[7] - 
                      this.entries[12] * this.entries[3] * this.entries[5];

            inv.entries[14] = -this.entries[0]  * this.entries[5] * this.entries[14] + 
                       this.entries[0]  * this.entries[6] * this.entries[13] + 
                       this.entries[4]  * this.entries[1] * this.entries[14] - 
                       this.entries[4]  * this.entries[2] * this.entries[13] - 
                       this.entries[12] * this.entries[1] * this.entries[6] + 
                       this.entries[12] * this.entries[2] * this.entries[5];

            inv.entries[3] = -this.entries[1] * this.entries[6] * this.entries[11] + 
                      this.entries[1] * this.entries[7] * this.entries[10] + 
                      this.entries[5] * this.entries[2] * this.entries[11] - 
                      this.entries[5] * this.entries[3] * this.entries[10] - 
                      this.entries[9] * this.entries[2] * this.entries[7] + 
                      this.entries[9] * this.entries[3] * this.entries[6];

            inv.entries[7] = this.entries[0] * this.entries[6] * this.entries[11] - 
                     this.entries[0] * this.entries[7] * this.entries[10] - 
                     this.entries[4] * this.entries[2] * this.entries[11] + 
                     this.entries[4] * this.entries[3] * this.entries[10] + 
                     this.entries[8] * this.entries[2] * this.entries[7] - 
                     this.entries[8] * this.entries[3] * this.entries[6];

            inv.entries[11] = -this.entries[0] * this.entries[5] * this.entries[11] + 
                       this.entries[0] * this.entries[7] * this.entries[9] + 
                       this.entries[4] * this.entries[1] * this.entries[11] - 
                       this.entries[4] * this.entries[3] * this.entries[9] - 
                       this.entries[8] * this.entries[1] * this.entries[7] + 
                       this.entries[8] * this.entries[3] * this.entries[5];

            inv.entries[15] = this.entries[0] * this.entries[5] * this.entries[10] - 
                      this.entries[0] * this.entries[6] * this.entries[9] - 
                      this.entries[4] * this.entries[1] * this.entries[10] + 
                      this.entries[4] * this.entries[2] * this.entries[9] + 
                      this.entries[8] * this.entries[1] * this.entries[6] - 
                      this.entries[8] * this.entries[2] * this.entries[5];

            det = this.entries[0] * inv.entries[0] + this.entries[1] * inv.entries[4] + this.entries[2] * inv.entries[8] + this.entries[3] * inv.entries[12];

            det = 1.0 / det;

            for (i = 0; i < 16; i++)
                inv.entries[i] *= det;
            return inv;
        },
        to_string: function () {
            let ret = '[';
            for (let row = 0; row < this.rows; ++row) {
                for (let col = 0; col < this.cols; ++col) {
                    if (col == 0 && row != 0)
                        ret += ' ';
                    ret += this.at(row, col).toFixed(3).padStart(8, ' ');
                    ret += ','
                }
                ret += '\n';
            }
            return ret + ']';
        }
    };
};

// Creates a 4x4 Mat with 0 entries
const Mat4 = () => {
    let ret = MatBaseObject();
    ret.entries.fill(0);
    return ret;
};
// Creates a 4x4 identity matrix
const Identity4 = () => {
    let ret = MatBaseObject();
    for (let i = 0; i < 16; ++i) {
        if (Math.floor(i / 4) == (i % 4))
            ret.entries[i] = 1;
        else
            ret.entries[i] = 0;
    }
    return ret;
};
// Creates a 4x4 translation matrix
const Translate = (x, y, z) => {
    let ret = Identity4();
    ret.entries[ret.el_idx(0, 3)] = x;
    ret.entries[ret.el_idx(1, 3)] = y;
    ret.entries[ret.el_idx(2, 3)] = z;
    return ret;
};
// Creates a 4x4 scale matrix
const Scale = (x, y, z) => {
    let ret = Mat4();
    ret.entries[ret.el_idx(0, 0)] = x;
    ret.entries[ret.el_idx(1, 1)] = y;
    ret.entries[ret.el_idx(2, 2)] = z;
    ret.entries[ret.el_idx(3, 3)] = 1;
    return ret;
};
// Returns a 4x4 rotation matrix with the entries taken from the vectors spanning the new basis
const Rotation = (x_dir, y_dir, z_dir) => {
    let ret = Mat4();
    for (let i = 0; i < 3; ++i)
        ret.entries[4 * i] = x_dir.entries[i];
    for (let i = 0; i < 3; ++i)
        ret.entries[4 * i + 1] = y_dir.entries[i];
    for (let i = 0; i < 3; ++i)
        ret.entries[4 * i + 2] = z_dir.entries[i];
    ret.entries[15] = 1;
    return ret;
};
/**
 * The resulting view matrix makes such that after applying the matrix will set
 * the center of the coordinate system to pos, and align the coordinate system to have -z point
 * into depth
 * @param pos Vec4 with the position of the viewer
 * @param at Vec4 with the position the viewer looks at
 * @param up Vec4 with the direction of the viewers up direction
 */
const LookAt = (pos, at, up) => {
    if (!pos.is_vec())
        throw Error('pos is not a vec4');
    if (!at.is_vec())
        throw Error('at is not a vec4');
    if (!up.is_vec())
        throw Error('up is not a vec4');
    if (!pos.is_absolute_vec())
        throw Error('pos is not an absolution position');
    if (!at.is_absolute_vec())
        throw Error('at is not an absolution position');
    if (!up.is_relative_vec())
        throw Error('up is not a direction');
    let depth = at.subtract(pos).normalize();
    let right = depth.cross(up).normalize();
    let corrected_up = right.cross(depth).normalize();
    return Rotation(right, corrected_up, depth).mul(Translate(-pos.x(), -pos.y(), -pos.z()));
};
/**
 * Creates a view matrix for a first person camera.
 * A direction of 0 degrees means looking straight in the direction of the y axis (which is transformed to be the standard depth axis)
 * A pitch of 0 degrees means looking straight in the direction of the y axis, negativ numbers will cause a look down, positive numbers a look up
 * @param {Vec4} pos 3d position of the camera
 * @param {Float} direction Direction in degrees with direction \in [-180, 180]. If direction is outside, direction gets wrapped.
 * @param {Float} pitch Pitch in degrees wiht pitch \in [-90, 90]. If pitch is outside of the valid interval it is clamped.
 */
const FirstPerson = (pos, direction, pitch) => {
    while (direction < -180)
        direction += 360;
    while (direction > 180)
        direction -= 360;
    pitch = Math.min(Math.max(pitch, -90), 90);
    const DEG2RAD = Math.acos(-1.0) / 180;
    direction *= DEG2RAD;
    pitch *= DEG2RAD;
    let p = Math.cos(pitch);
    let front = Vec4(Math.sin(direction) * p, Math.cos(direction) * p, Math.sin(pitch), 0);
    return LookAt(pos, pos.addition(front), Vec4(0, 0, 1, 0));
};
const Perspective = (top, right, front, back) => {
    let m = Mat4();
    m.entries[0] = front / right;
    m.entries[5] = front / top;
    m.entries[10] = -(back + front) / (back - front);
    m.entries[11] = -1;
    m.entries[14] = -(2 * back * front) / (back - front);
    m.entries[15] = 0;
    return m;
};
/**
 * @brief Creates a projection matrix with a given fov
 * The filed of view (fov) is expected to be inserted in angles
 */
const PerspectiveFov = (fovY, aspectRatio, front, back) => {
    const DEG2RAD = Math.acos(-1.0) / 180;

    let tangent = Math.tan(fovY / 2 * DEG2RAD);   // tangent of half fovY
    let top = front * tangent;                  // half height of near plane
    let right = top * aspectRatio;              // half width of near plane

    return Perspective(top, right, front, back);
};
const Orthographic = (top, right, front, back) => {
    let m = Mat4();
    m.entries[0] = 1 / right;
    m.entries[5] = 1 / top;
    m.entries[10] = -(2) / (back - front);
    m.entries[14] = -(back + front) / (back - front);
    m.entries[15] = 1;
    return m;
};
/**
 * Creates a homogenous vector (3d vector with added w for matrix operations)
 * @param {Float} x 
 * @param {Float} y 
 * @param {Float} z 
 * @param {Float} w Homogenous parameter, 1 for absolute position, 0 for direction/relative position
 */
const Vec4 = (x = 0, y = 0, z = 0, w = 1) => {
    let ret = MatBaseObject(4, 1);
    ret.entries = [x, y, z, w];
    return ret;
};
/**
 * Transforms projected depth back to linear depth
 * @param {Float} depth depth from the depth buffer (projected depth)
 * @param {Float} front near plane of the perspective transformation
 * @param {Float} back far plane of the perspective transformation
 */
const projected_to_linear_depth = (depth, front, back) => {
    const b_m_f = back - front;
    const b_p_f = back + front;
    return (-2 * back * front / b_m_f) / (-depth + b_p_f / b_m_f);
}

/**
 * Predefined testing function
 */
function linalg_tests() {
    const running_prefix = '[RUNNING...] ';
    const success_prefix = '[...SUCCESS] ';
    const error_prefix = '[.....ERROR] ';
    const TEST = async (test_name, test_function) => {
        console.log(running_prefix + test_name);
        try {
            test_function();
            console.log(success_prefix + test_name);
        }
        catch (e) {
            console.log(error_prefix + test_name + ': ' + e.message + '\n' + e.stack);
        }
    };
    const ASSERT = (condition) => {
        if (!condition) {
            throw Error('');
        }
    }
    TEST('ZeroMatTests', () => {
        let m = Mat4();
        console.log(m.to_string());
        ASSERT(m.entries.filter(x => x == 0).length == 16);
        ASSERT(m.multiply(m).entries.filter(x => x == 0).length == 16);
    });
    TEST('IdentityTests', () => {
        let m = Identity4();
        console.log(m.to_string());
        ASSERT(m.entries.filter(x => x == 0).length == 12);
        ASSERT(m.entries.filter(x => x == 1).length == 4);
        ASSERT(m.multiply(m).entries.filter(x => x == 0).length == 12);
        ASSERT(m.multiply(m).entries.filter(x => x == 1).length == 4);
    });
    TEST('TranslateTests', () => {
        let m = Translate(1, 2, 3);
        console.log(m.to_string());
        let v = Vec4(-1, -2, -3);
        let r = m.multiply(v);
        console.log(r.to_string());
        ASSERT(r.equals(Vec4()));
    });
    TEST('ScaleTests', () => {
        let m = Scale(1, 2, 3);
        console.log(m.to_string());
    });
    TEST('RotationTests', () => {
        let span_x = Vec4(1, 0, 1);
        let span_y = Vec4(0, 1, 0);
        let span_z = Vec4(0, 1, 1);
        let m = Rotation(span_x, span_y, span_z);
        console.log(m.to_string());
    });
    TEST('LookAtTests', () => {
        let m = LookAt(Vec4(1, 2, 3), Vec4(), Vec4(0, 0, 1, 0));
        console.log(m.to_string());
    });
    TEST('FirstPersonTests', () => {
        let m = FirstPerson(Vec4(1, 2, 3), 0, 0);
        console.log(m.to_string());
    });
    TEST('ProjectionTests', () => {
        let m = PerspectiveFov(60, 1, .1, 1000);
        console.log(m.to_string());
    });
    TEST('IntegrationTests', () => {
        let m = Translate(2, 4, 6).multiply(Scale(2, 2, 2));
        console.log(m.to_string());
        let r = m.multiply(Vec4(-1, -2, -3));
        console.log(r.to_string());
        ASSERT(r.equals(Vec4()));
        m = Rotation(Vec4(0, 0, 1), Vec4(1, 0, 0), Vec4(0, 1, 0));
        ASSERT(m.multiply(m.transpose()).equals(Identity4()));
    });
    TEST('Inverse tests', () => {
        let m = Translate(2,4,6).multiply(Scale(2,2,2));
        let inv = m.inverse();
        console.log(m.to_string());
        console.log(inv.to_string());
        ASSERT(m.multiply(inv).equals(Identity4()));
    });
}