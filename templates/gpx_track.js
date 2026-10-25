/**
 * @brief Gpx track editing, gps recording and track rendering for the gpx editor
 *
 * GpxDocument   keeps the gpx xml document as source of truth and edits it in place (unknown elements are preserved)
 * MotionSensor  inertial sensors of the phone (earth frame acceleration, stand still detection)
 * PositionFilter kalman filter of the own position from gps fixes, gps doppler speed and the inertial sensors
 * GpsRecorder   records filtered gps points and supports averaging a point while standing still
 * TrackRenderer draws the tracks draped on the terrain without vertex buffers (positions come from a float texture)
 * TrackFollower gives positions along the tracks by distance for the follow animation
 *
 * All positions are stored in global uv coordinates (web mercator, 0-1) as used by the virtual maps
 */

const gpx_empty_document = `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="home_server gpx editor" xmlns="http://www.topografix.com/GPX/1/1">
</gpx>`;
const gpx_max_undo = 50;

const GpxUtil = {
    earth_circumference_m: 40075016.686,
    uv_to_wgs_84: function (x, y) {
        return [Math.atan(Math.sinh(Math.PI * (1 - 2 * y))) * 180 / Math.PI, x * 360 - 180];
    },
    /** @returns {float} meters per uv unit at the given uv y coordinate (mercator is conformal, so it holds for x and y) */
    meters_per_uv: function (y) {
        const lat = Math.atan(Math.sinh(Math.PI * (1 - 2 * y)));
        return this.earth_circumference_m * Math.cos(lat);
    },
    distance_m: function (a, b) {
        return Math.hypot(b.x - a.x, b.y - a.y) * this.meters_per_uv(.5 * (a.y + b.y));
    },
};

/**
 * @brief a point of a segment, element is the trkpt/rtept/wpt xml element
 * @typedef {{element: Element, x: float, y: float}} GpxPoint
 * @typedef {{kind: string, element: Element, points: Array.<GpxPoint>}} GpxSegment kind is one of 'trk', 'rte', 'wpt'
 */
const GpxDocument = () => {
    return {
        /** @type {XMLDocument} */
        xml: null,
        /** @type {Array.<GpxSegment>} */
        segments: [],
        parse_error: false,     // the loaded text was no valid xml, saving is disabled to not destroy the file
        version: 0,             // incremented on every change
        undo_stack: [],

        load: function (text) {
            this.parse_error = false;
            let xml = null;
            if (text && text.trim().length) {
                xml = new DOMParser().parseFromString(text, "application/xml");
                if (xml.getElementsByTagName("parsererror").length) {
                    console.error("GpxDocument::load() could not parse the gpx file");
                    this.parse_error = true;
                    xml = null;
                }
            }
            this.xml = xml || new DOMParser().parseFromString(gpx_empty_document, "application/xml");
            this.rebuild_segments();
            this.version++;
            return this;
        },
        serialize: function () {
            const text = new XMLSerializer().serializeToString(this.xml).replace(/^<\?xml[^>]*\?>\s*/, "");
            return '<?xml version="1.0" encoding="UTF-8"?>\n' + text;
        },
        rebuild_segments: function () {
            const children = (e, name) => Array.from(e.children).filter(c => c.localName == name);
            const root = this.xml.documentElement;
            this.segments = [];
            for (const trk of children(root, "trk"))
                for (const seg of children(trk, "trkseg"))
                    this.segments.push({kind: "trk", element: seg, points: children(seg, "trkpt").map(e => this.point_from_element(e))});
            for (const rte of children(root, "rte"))
                this.segments.push({kind: "rte", element: rte, points: children(rte, "rtept").map(e => this.point_from_element(e))});
            const wpts = children(root, "wpt");
            if (wpts.length)
                this.segments.push({kind: "wpt", element: root, points: wpts.map(e => this.point_from_element(e))});
        },
        point_from_element: function (e) {
            const [x, y] = Util.wgs_84_to_uv(parseFloat(e.getAttribute("lat")), parseFloat(e.getAttribute("lon")));
            return {element: e, x: x, y: y};
        },
        /** @brief stores the current state for undo, has to be called before every user edit */
        push_undo: function () {
            this.undo_stack.push(this.serialize());
            if (this.undo_stack.length > gpx_max_undo)
                this.undo_stack.shift();
        },
        /** @returns {bool} false if there was nothing to undo */
        undo: function () {
            if (!this.undo_stack.length)
                return false;
            this.load(this.undo_stack.pop());
            return true;
        },
        child_element: function (e, name) {
            return Array.from(e.children).find(c => c.localName == name);
        },
        create_element: function (name, text) {
            let e = this.xml.createElementNS(this.xml.documentElement.namespaceURI, name);
            if (text !== undefined)
                e.textContent = text;
            return e;
        },
        /** @returns {string} indentation for a new child element of parent inserted before ref (appended if null), null if unformatted */
        indent_for: function (parent, ref) {
            const ws = n => n && n.nodeType == Node.TEXT_NODE && !n.textContent.trim();
            const neighbour = ref || parent.lastElementChild;
            if (neighbour)
                return ws(neighbour.previousSibling) ? neighbour.previousSibling.textContent : null;
            return ws(parent.lastChild) ? parent.lastChild.textContent + "  " : null;
        },
        /** @brief inserts the element before ref (appends if null) with the indentation of the neighbouring elements, so every point stays on its own line */
        insert_element: function (parent, e, ref) {
            const indent = this.indent_for(parent, ref);
            if (ref) {
                // the existing indentation stays in front of e, ref gets a new one
                parent.insertBefore(e, ref);
                if (indent !== null)
                    parent.insertBefore(this.xml.createTextNode(indent), ref);
                return;
            }
            // appending before the closing indentation of the parent
            const closing = parent.lastChild && parent.lastChild.nodeType == Node.TEXT_NODE && !parent.lastChild.textContent.trim() ? parent.lastChild : null;
            if (indent !== null)
                parent.insertBefore(this.xml.createTextNode(indent), closing);
            parent.insertBefore(e, closing);
        },
        remove_element: function (e) {
            const prev = e.previousSibling;
            if (prev && prev.nodeType == Node.TEXT_NODE && !prev.textContent.trim())
                prev.remove();
            e.remove();
        },
        /** @brief sets position and elevation (removed if null) of a point */
        set_point: function (point, x, y, ele) {
            const [lat, lon] = GpxUtil.uv_to_wgs_84(x, y);
            point.element.setAttribute("lat", lat.toFixed(7));
            point.element.setAttribute("lon", lon.toFixed(7));
            point.x = x;
            point.y = y;
            let ele_element = this.child_element(point.element, "ele");
            if (ele === null || ele === undefined) {
                if (ele_element)
                    ele_element.remove();
            } else {
                if (!ele_element) {
                    ele_element = this.create_element("ele");
                    point.element.insertBefore(ele_element, point.element.firstChild);
                }
                ele_element.textContent = ele.toFixed(1);
            }
            this.version++;
        },
        /**
         * @brief inserts a new point into the segment at index i
         * @param {{x: float, y: float, ele: float, time: Date, desc: string}} p
         */
        insert_point: function (segment, i, p) {
            const tag = segment.kind == "trk" ? "trkpt" : segment.kind == "rte" ? "rtept" : "wpt";
            let e = this.create_element(tag);
            if (p.time)
                e.appendChild(this.create_element("time", p.time.toISOString()));
            if (p.desc)
                e.appendChild(this.create_element("desc", p.desc));
            const ref = i < segment.points.length ? segment.points[i].element :
                        segment.kind == "wpt" && segment.points.length ? segment.points[segment.points.length - 1].element.nextElementSibling : null;
            this.insert_element(segment.element, e, ref);
            const point = {element: e, x: 0, y: 0};
            segment.points.splice(i, 0, point);
            this.set_point(point, p.x, p.y, p.ele);
            return point;
        },
        delete_point: function (segment, i) {
            this.remove_element(segment.points[i].element);
            segment.points.splice(i, 1);
            this.version++;
        },
        /** @returns {GpxSegment} a new track with an empty segment */
        create_track: function (name) {
            const root = this.xml.documentElement;
            // tracks have to be after waypoints and routes
            const ref = this.child_element(root, "extensions") || null;
            const base = this.indent_for(root, ref) || "\n";
            let trk = this.create_element("trk");
            let seg = this.create_element("trkseg");
            seg.appendChild(this.xml.createTextNode(base + "  "));
            for (const e of [this.create_element("name", name), seg]) {
                trk.appendChild(this.xml.createTextNode(base + "  "));
                trk.appendChild(e);
            }
            trk.appendChild(this.xml.createTextNode(base));
            this.insert_element(root, trk, ref);
            const segment = {kind: "trk", element: seg, points: []};
            const last_trk = this.segments.findLastIndex(s => s.kind == "trk");
            this.segments.splice(last_trk + 1, 0, segment);
            this.version++;
            return segment;
        },
        /** @brief removes a segment, its track is removed as well if it has no other segment */
        remove_segment: function (segment) {
            let e = segment.element;
            if (segment.kind == "trk" && Array.from(e.parentElement.children).filter(c => c.localName == "trkseg").length == 1)
                e = e.parentElement;
            if (segment.kind == "wpt")
                segment.points.forEach(p => this.remove_element(p.element));
            else
                this.remove_element(e);
            this.segments.splice(this.segments.indexOf(segment), 1);
            this.version++;
        },
        /** @returns {float} length of all tracks and routes in meters */
        length_m: function () {
            let l = 0;
            for (const s of this.segments)
                if (s.kind != "wpt")
                    for (let i = 1; i < s.points.length; ++i)
                        l += GpxUtil.distance_m(s.points[i - 1], s.points[i]);
            return l;
        },
        point_count: function () {
            return this.segments.reduce((n, s) => n + s.points.length, 0);
        },
    };
};

/**
 * @brief inertial data of the phone: linear acceleration in the east/south frame of the uv coordinates and stand still detection
 *
 * The acceleration is rotated into the earth frame with the absolute device orientation (compass based). Without an
 * absolute orientation only the stand still detection is available, as it only needs the magnitudes
 */
const MotionSensor = () => {
    return {
        active: false,
        /** true if the orientation is relative to north, only then the acceleration direction is known */
        absolute: false,
        stationary: false,
        sample_count: 0,
        error: "",
        orientation: null,          // {alpha, beta, gamma} in degrees
        window: [],                 // {t, a, r} samples of the last stationary_window_s for the stand still detection
        stationary_window_s: 1,
        stationary_max_acc: .35,    // m/s^2, hand tremor while standing is below this
        stationary_max_rot: 12,     // deg/s
        /** @type {function(float, Array.<float>, bool):void} called per sample with the time in s, [east, south] acceleration in m/s^2 (null if unknown) and the stand still flag */
        on_sample: null,
        /** @type {function():void} called if the state (active, absolute, stationary) changed */
        on_update: null,

        /** @brief has to be called from a user gesture for the permission request on iOS @returns {Promise<bool>} */
        start: async function () {
            if (this.active)
                return true;
            if (!window.DeviceMotionEvent) {
                this.error = "Keine Bewegungssensoren";
                return false;
            }
            try {
                if (typeof DeviceMotionEvent.requestPermission == "function" && await DeviceMotionEvent.requestPermission() != "granted")
                    throw new Error("nicht erlaubt");
                if (window.DeviceOrientationEvent && typeof DeviceOrientationEvent.requestPermission == "function")
                    await DeviceOrientationEvent.requestPermission();
            } catch (e) {
                this.error = "Bewegungssensoren: " + e.message;
                this.notify();
                return false;
            }
            this.active = true;
            this.error = "";
            this.orientation_listener = (e) => this.handle_orientation(e);
            this.motion_listener = (e) => this.handle_motion(e);
            // chrome only gives the north based orientation with the absolute event, safari has webkitCompassHeading instead
            this.orientation_event = "ondeviceorientationabsolute" in window ? "deviceorientationabsolute" : "deviceorientation";
            window.addEventListener(this.orientation_event, this.orientation_listener);
            window.addEventListener("devicemotion", this.motion_listener);
            this.notify();
            return true;
        },
        stop: function () {
            if (!this.active)
                return;
            window.removeEventListener(this.orientation_event, this.orientation_listener);
            window.removeEventListener("devicemotion", this.motion_listener);
            this.active = this.absolute = this.stationary = false;
            this.orientation = null;
            this.window = [];
            this.notify();
        },
        notify: function () {
            if (this.on_update)
                this.on_update();
        },
        handle_orientation: function (e) {
            if (e.alpha === null || e.beta === null || e.gamma === null)
                return;
            let alpha = e.alpha, absolute = e.absolute || e.type == "deviceorientationabsolute";
            if (typeof e.webkitCompassHeading == "number" && e.webkitCompassHeading >= 0) {
                // compass heading is clockwise, alpha counter clockwise
                alpha = 360 - e.webkitCompassHeading;
                absolute = true;
            }
            this.orientation = {alpha: alpha, beta: e.beta, gamma: e.gamma};
            if (absolute != this.absolute) {
                this.absolute = absolute;
                this.notify();
            }
        },
        /** @returns {Array.<float>} vector v in device coordinates rotated to the earth frame (east, north, up), see the w3c device orientation spec */
        device_to_earth: function (v) {
            const o = this.orientation, d = Math.PI / 180;
            const cA = Math.cos(o.alpha * d), sA = Math.sin(o.alpha * d);
            const cB = Math.cos(o.beta * d), sB = Math.sin(o.beta * d);
            const cG = Math.cos(o.gamma * d), sG = Math.sin(o.gamma * d);
            return [(cA * cG - sA * sB * sG) * v[0] - cB * sA * v[1] + (cG * sA * sB + cA * sG) * v[2],
                    (cG * sA + cA * sB * sG) * v[0] + cA * cB * v[1] + (sA * sG - cA * cG * sB) * v[2],
                    -cB * sG * v[0] + sB * v[1] + cB * cG * v[2]];
        },
        handle_motion: function (e) {
            const t = Date.now() / 1000;
            const vec = (a) => a && a.x !== null && a.y !== null && a.z !== null ? [a.x, a.y, a.z] : null;
            let acc = vec(e.acceleration), earth = null;
            if (this.orientation) {
                if (acc)
                    earth = this.device_to_earth(acc);
                else if (vec(e.accelerationIncludingGravity)) {
                    // devices without gyroscope only give the acceleration including gravity, which points up at rest
                    earth = this.device_to_earth(vec(e.accelerationIncludingGravity));
                    earth[2] -= 9.81;
                    acc = earth;
                }
            }
            if (!acc)
                return;
            ++this.sample_count;
            const r = e.rotationRate && e.rotationRate.alpha !== null ? Math.hypot(e.rotationRate.alpha, e.rotationRate.beta, e.rotationRate.gamma) : 0;
            this.window.push({t: t, a: Math.hypot(...acc), r: r});
            while (this.window.length && this.window[0].t < t - this.stationary_window_s)
                this.window.shift();
            const covered = this.window.length > 5 && t - this.window[0].t > .8 * this.stationary_window_s;
            const stationary = covered && this.window.every(s => s.a < this.stationary_max_acc && s.r < this.stationary_max_rot);
            if (stationary != this.stationary) {
                this.stationary = stationary;
                this.notify();
            }
            if (!this.on_sample)
                return;
            // shocks (steps, bumps) are clamped, they average out but would dominate single predictions
            const clamp = (x) => Math.min(Math.max(x, -8), 8);
            const en = earth && this.absolute ? [clamp(earth[0]), -clamp(earth[1])] : null;  // uv y points south
            this.on_sample(t, en, stationary);
        },
    };
};

/**
 * @brief kalman filter of the own position combining the gps fixes, the gps doppler speed and the inertial sensors
 *
 * Constant velocity model per axis in meters relative to an origin (uv), the measured acceleration is used as control input
 * of the prediction. While standing still (detected from the inertial sensors) the velocity is pulled to zero, which keeps
 * the position from drifting with the gps noise
 */
const PositionFilter = () => {
    return {
        acceleration_noise: .3,         // process noise of the constant velocity model in m^2/s^3 (unknown walking acceleration)
        imu_acceleration_noise: .1,     // remaining process noise if the measured acceleration is used
        imu_max_fix_age_s: 5,           // the acceleration is integrated only this long after a gps fix, it drifts quickly
        speed_sigma_mps: .4,            // standard deviation of the gps doppler velocity
        zero_velocity_sigma_mps: .05,   // standard deviation of the velocity while standing still
        max_gap_s: 30,                  // the filter is reset after a longer gps gap
        max_extrapolation_s: 2,
        /** per axis position and velocity in meters relative to origin (uv) with 2x2 covariance [pp, pv, vp, vv] */
        kf: null,
        /** @type {GeolocationPosition} */
        last_fix: null,
        last_fix_t: 0,
        imu_used: false,                // true if the last prediction used the measured acceleration

        reset: function (x, y, pos_var, t, vel_var = 4) {
            const axis = () => ({p: 0, v: 0, P: [pos_var, 0, 0, vel_var]});
            this.kf = {origin: {x: x, y: y}, m_per_uv: GpxUtil.meters_per_uv(y), axes: [axis(), axis()], t: t};
        },
        /** @brief prediction to time t with the optional acceleration [east, south] in m/s^2 */
        predict: function (t, acc = null) {
            const kf = this.kf;
            const dt = t - kf.t;
            if (!(dt > 0))
                return;
            const q = acc ? this.imu_acceleration_noise : this.acceleration_noise;
            kf.axes.forEach((a, i) => {
                const u = acc ? acc[i] : 0;
                a.p += a.v * dt + .5 * u * dt * dt;
                a.v += u * dt;
                const [pp, pv, vp, vv] = a.P;
                a.P = [pp + dt * (pv + vp) + dt * dt * vv + q * dt ** 3 / 3, pv + dt * vv + q * dt * dt / 2,
                       vp + dt * vv + q * dt * dt / 2, vv + q * dt];
            });
            kf.t = t;
        },
        /** @brief kalman update of the position (state 0) or velocity (state 1) of axis a with measurement z of variance r */
        update: function (a, state, z, r) {
            const [pp, pv, vp, vv] = a.P;
            const s = (state ? vv : pp) + r;
            const k0 = (state ? pv : pp) / s, k1 = (state ? vv : vp) / s;
            const innovation = z - (state ? a.v : a.p);
            a.p += k0 * innovation;
            a.v += k1 * innovation;
            a.P = state ? [pp - k0 * vp, pv - k0 * vv, vp - k1 * vp, vv - k1 * vv]
                        : [pp - k0 * pp, pv - k0 * pv, vp - k1 * pp, vv - k1 * pv];
        },
        /** @returns {bool} false if the fix was already added (several position watches get the same fixes) */
        add_fix: function (pos) {
            if (this.last_fix && pos.timestamp <= this.last_fix.timestamp)
                return false;
            const c = pos.coords;
            const [x, y] = Util.wgs_84_to_uv(c.latitude, c.longitude);
            const r = c.accuracy * c.accuracy;
            // the fix is a bit older than the inertial predictions, it is applied at the current filter time
            const t = Math.max(pos.timestamp / 1000, this.kf ? this.kf.t : 0);
            this.last_fix = pos;
            if (!this.kf || t - this.last_fix_t > this.max_gap_s) {
                this.reset(x, y, r, t);
                this.last_fix_t = t;
                return true;
            }
            this.last_fix_t = t;
            this.predict(t);
            const kf = this.kf;
            const z = [(x - kf.origin.x) * kf.m_per_uv, (y - kf.origin.y) * kf.m_per_uv];
            kf.axes.forEach((a, i) => this.update(a, 0, z[i], r));
            // doppler velocity, much more precise than the position differences
            if (c.speed !== null && c.speed >= 0 && c.heading !== null && isFinite(c.heading)) {
                const h = c.heading * Math.PI / 180;
                const v = [c.speed * Math.sin(h), -c.speed * Math.cos(h)];
                kf.axes.forEach((a, i) => this.update(a, 1, v[i], this.speed_sigma_mps ** 2));
            }
            return true;
        },
        /** @brief inertial sample at time t with the acceleration [east, south] (null if the direction is unknown) */
        imu_sample: function (t, acc, stationary) {
            if (!this.kf)
                return;
            this.imu_used = !!acc && !stationary && t - this.last_fix_t < this.imu_max_fix_age_s;
            // without measured acceleration the prediction is left to position(), which limits the extrapolation.
            // Predicting here would move the position along the (noisy) velocity forever and redraw the map every frame
            if (!this.imu_used && !stationary)
                return;
            this.predict(t, this.imu_used ? acc : null);
            if (stationary)
                this.kf.axes.forEach(a => this.update(a, 1, 0, this.zero_velocity_sigma_mps ** 2));
        },
        /** @returns {{x: float, y: float}} position extrapolated to time t in s, null without fix */
        position: function (t = Date.now() / 1000) {
            const kf = this.kf;
            if (!kf)
                return null;
            const dt = Math.min(Math.max(t - kf.t, 0), this.max_extrapolation_s);
            return {x: kf.origin.x + (kf.axes[0].p + kf.axes[0].v * dt) / kf.m_per_uv,
                    y: kf.origin.y + (kf.axes[1].p + kf.axes[1].v * dt) / kf.m_per_uv};
        },
        /** @returns {float} standard deviation of the filtered position in meters */
        accuracy_m: function () {
            return this.kf ? Math.sqrt(Math.max(this.kf.axes[0].P[0], this.kf.axes[1].P[0])) : NaN;
        },
        speed_mps: function () {
            return this.kf ? Math.hypot(this.kf.axes[0].v, this.kf.axes[1].v) : 0;
        },
        /** @returns {{x: float, y: float}} filtered velocity in m/s along the uv axes (x east, y south), null without fix */
        velocity_mps: function () {
            return this.kf ? {x: this.kf.axes[0].v, y: this.kf.axes[1].v} : null;
        },
    };
};

/**
 * @brief records gps points. The fixes are smoothed with the position filter (shared with the position display), fixes with
 * bad accuracy are not recorded and a point is emitted every min_distance_m.
 * For a precise single point the position can be averaged over all fixes while standing still (weighted by 1 / accuracy^2)
 * @param {PositionFilter} position_filter
 */
const GpsRecorder = (position_filter) => {
    return {
        max_accuracy_m: 20,
        min_distance_m: 3,
        recording: false,
        watch_id: null,
        wake_lock: null,
        position_filter: position_filter,
        /** @type {GeolocationPosition} */
        last_fix: null,
        last_emitted: null,
        /** @type {{sum_w: float, sum_x: float, sum_y: float, samples: Array.<{x: float, y: float, w: float}>, start: float}} */
        averaging: null,
        fix_count: 0,
        rejected_count: 0,
        error: "",
        /** @type {function({x: float, y: float, time: Date, desc: string}):void} */
        on_point: null,
        /** @type {function():void} called on every status change */
        on_update: null,

        start: function () {
            if (!window.isSecureContext || !navigator.geolocation) {
                this.error = "GPS ist nur über https verfügbar";
                this.notify();
                return false;
            }
            this.recording = true;
            this.last_emitted = null;
            this.fix_count = this.rejected_count = 0;
            this.error = "";
            this.watch_id = navigator.geolocation.watchPosition(p => this.handle_fix(p), e => { this.error = e.message; this.notify(); },
                                                                {enableHighAccuracy: true, maximumAge: 0, timeout: 30000});
            this.request_wake_lock();
            this.visibility_listener = () => {
                if (document.visibilityState == "visible" && this.recording)
                    this.request_wake_lock();
            };
            document.addEventListener("visibilitychange", this.visibility_listener);
            this.notify();
            return true;
        },
        stop: function () {
            this.recording = false;
            this.averaging = null;
            if (this.watch_id !== null)
                navigator.geolocation.clearWatch(this.watch_id);
            this.watch_id = null;
            if (this.wake_lock)
                this.wake_lock.release();
            this.wake_lock = null;
            document.removeEventListener("visibilitychange", this.visibility_listener);
            this.notify();
        },
        /** @brief keeps the screen on, browsers stop the gps updates for pages in the background */
        request_wake_lock: async function () {
            try {
                if (navigator.wakeLock)
                    this.wake_lock = await navigator.wakeLock.request("screen");
            } catch (e) {
                console.log("GpsRecorder: wake lock not available " + e);
            }
        },
        notify: function () {
            if (this.on_update)
                this.on_update();
        },
        /** @returns {{x: float, y: float}} filtered position */
        position: function () {
            return this.position_filter.position();
        },
        handle_fix: function (pos) {
            const c = pos.coords;
            const [x, y] = Util.wgs_84_to_uv(c.latitude, c.longitude);
            // the filter ignores fixes it already got from another position watch
            this.position_filter.add_fix(pos);
            this.last_fix = pos;
            this.fix_count++;
            if (c.accuracy > this.max_accuracy_m) {
                this.rejected_count++;
                this.notify();
                return;
            }
            const w = 1 / (c.accuracy * c.accuracy);
            if (this.averaging) {
                this.averaging.sum_w += w;
                this.averaging.sum_x += w * x;
                this.averaging.sum_y += w * y;
                this.averaging.samples.push({x: x, y: y, w: w});
            }
            // while averaging no track points are emitted, the averaged point is added on finish
            const p = this.position_filter.position();
            if (!this.averaging && (!this.last_emitted || GpxUtil.distance_m(this.last_emitted, p) >= this.min_distance_m)) {
                this.last_emitted = p;
                if (this.on_point)
                    this.on_point({x: p.x, y: p.y, time: new Date(pos.timestamp)});
            }
            this.notify();
        },
        /** @returns {float} standard deviation of the filtered position in meters */
        filter_accuracy_m: function () {
            return this.position_filter.accuracy_m();
        },
        start_averaging: function () {
            this.averaging = {sum_w: 0, sum_x: 0, sum_y: 0, samples: [], start: Date.now()};
            this.notify();
        },
        /** @returns {{x: float, y: float, n: int, precision_m: float, scatter_m: float, duration_s: float}} null if no samples */
        averaging_result: function () {
            const a = this.averaging;
            if (!a || !a.samples.length)
                return null;
            const x = a.sum_x / a.sum_w, y = a.sum_y / a.sum_w;
            const m_per_uv = GpxUtil.meters_per_uv(y);
            const scatter = Math.sqrt(a.samples.reduce((s, p) => s + p.w * ((p.x - x) ** 2 + (p.y - y) ** 2), 0) / a.sum_w) * m_per_uv;
            // precision of the mean for independent errors, gps errors are correlated over time so this is optimistic
            return {x: x, y: y, n: a.samples.length, precision_m: Math.sqrt(1 / a.sum_w), scatter_m: scatter, duration_s: (Date.now() - a.start) / 1000};
        },
        /** @brief emits the averaged point and continues the normal recording from there */
        finish_averaging: function () {
            const res = this.averaging_result();
            this.averaging = null;
            if (res) {
                // standing still at the end of the averaging
                this.position_filter.reset(res.x, res.y, res.precision_m ** 2, Math.max(Date.now() / 1000, this.position_filter.kf?.t ?? 0), .1);
                this.last_emitted = {x: res.x, y: res.y};
                if (this.on_point)
                    this.on_point({x: res.x, y: res.y, time: new Date(),
                                   desc: `Gemittelt aus ${res.n} Messungen über ${res.duration_s.toFixed(0)} s, Streuung ${res.scatter_m.toFixed(1)} m`});
            }
            this.notify();
            return res;
        },
        cancel_averaging: function () {
            this.averaging = null;
            this.notify();
        },
    };
};

/** @brief positions along all tracks and routes of a document by distance (segments are concatenated) */
const TrackFollower = () => {
    return {
        points: [],         // {x, y, s} with s the distance from the start in meters
        length_m: 0,
        init: function (doc) {
            this.points = [];
            let s = 0;
            for (const seg of doc.segments) {
                if (seg.kind == "wpt")
                    continue;
                for (let i = 0; i < seg.points.length; ++i) {
                    const p = seg.points[i];
                    if (i > 0)
                        s += GpxUtil.distance_m(seg.points[i - 1], p);
                    this.points.push({x: p.x, y: p.y, s: s});
                }
            }
            this.length_m = s;
            return this;
        },
        /** @returns {{x: float, y: float}} position at distance s, null if there are no points */
        position_at: function (s) {
            const p = this.points;
            if (!p.length)
                return null;
            s = Math.min(Math.max(s, 0), this.length_m);
            let lo = 0, hi = p.length - 1;
            while (hi - lo > 1) {
                const mid = (lo + hi) >> 1;
                if (p[mid].s <= s) lo = mid; else hi = mid;
            }
            const d = p[hi].s - p[lo].s;
            const t = d > 0 ? (s - p[lo].s) / d : 0;
            return {x: p[lo].x + t * (p[hi].x - p[lo].x), y: p[lo].y + t * (p[hi].y - p[lo].y)};
        },
    };
};

const track_texture_width = 2048;
const track_max_piece_m = 20;    // lines are subdivided into pieces of at most this length to follow the terrain

/**
 * @brief draws the tracks draped on the terrain. Points are stored in RGBA32F textures relative to an origin,
 * lines and points are generated from gl_VertexID as screen space quads
 */
const TrackRenderer = () => {
    return {
        /** @type {WebGL2RenderingContext} */
        gl: null,
        program: null,
        uniforms: {},
        line_texture: null,     // subdivided track points, z: 1 if connected to the next point
        line_count: 0,
        edit_texture: null,     // original points, z: 1 for waypoints, w: global point index
        edit_count: 0,
        segment_offsets: [],    // global point index of the first point of each segment
        origin: {x: 0, y: 0},
        version: -1,
        track_color: [.91, .28, .11, 1],
        track_outline: [.35, .08, .02, 1],

        /**
         * @param {WebGL2RenderingContext} gl
         * @param {VirtualMap} virtual_height_map needed for the heightmap uniform sizes
         * @param {int} height_level_offset offset from the terrain mesh level to the heightmap sample level
         */
        init: function (gl, virtual_height_map, height_level_offset) {
            this.gl = gl;
            const vs = `#version 300 es
            precision highp int;
            precision highp float;
            precision highp sampler2D;
            precision highp sampler2DArray;
            precision highp usampler2DArray;

            uniform sampler2D points;
            uniform int point_count;
            uniform vec2 points_origin;         // relative to grid_offset_pos
            uniform vec2 grid_offset_pos;
            uniform vec3 cam_pos;               // relative to grid_offset_pos
            uniform float eye_offset;           // distance the eye was moved back for the transition to 2d, not counted for the lift
            uniform mat4 view_proj;
            uniform vec2 viewport;
            uniform float size_px;              // line width or point diameter in pixels
            uniform float pixel_angle;          // 2 tan(fov / 2) / viewport height, world size of a pixel per distance
            uniform float lod_factor;           // same as for the terrain mesh, to sample the heightmap at the level of the terrain
            uniform int max_mesh_level;
            uniform int mode;                   // 0: lines, 1: points, 2: single marker at marker_pos
            uniform int edit_points;            // 1 if the points are the edit points (z marks waypoints), 0 for the line points
            uniform int only_waypoints;
            uniform vec2 marker_pos;            // relative to grid_offset_pos
            ${Util.glsl_virtual_texture_uniforms("heightmap", virtual_height_map)}
            ${Util.glsl_virtual_heightmap_load()}
            ${Util.glsl_wgs_84_m_to_uv()}

            out vec2 corner;
            flat out int point_index;
            flat out float point_kind;

            const vec4 culled = vec4(2., 2., 2., 1.);
            const float min_w = 1e-9;

            vec4 point_data(int i) { return texelFetch(points, ivec2(i % ${track_texture_width}, i / ${track_texture_width}), 0); }

            // extra_px: screen size of the drawn quad, the quad is lifted by its world size to not intersect the terrain in front of it
            vec4 clip_pos(vec2 p, float extra_px) {
                float dist = max(length(p - cam_pos.xy), 1e-12);
                float mesh_level = clamp(ceil(log2(lod_factor / dist)), 0., float(max_mesh_level));   // same lod as the terrain mesh tiles
                float level = max(mesh_level + ${height_level_offset}., 0.);
                vec3 pos = vec3(p, wgs_84_m_to_uv(virtual_heightmap_load(grid_offset_pos, p, level).x) * 1.4);
                // lifted towards the camera to avoid z fighting with the terrain
                vec3 to_cam = cam_pos - pos;
                float d = length(to_cam);
                float d_lift = max(d - eye_offset, 0.);
                pos += to_cam / d * min(.5 * d, wgs_84_m_to_uv(1.5) + .003 * d_lift + extra_px * pixel_angle * d);
                return view_proj * vec4(pos, 1.);
            }

            void main() {
                int c = gl_VertexID % 6;
                // quad corners of the two triangles
                vec2 offset = vec2(c == 1 || c == 4 || c == 5 ? 1. : -1., c == 2 || c == 3 || c == 5 ? 1. : -1.);
                if (mode == 0) {
                    int seg = gl_VertexID / 6;
                    vec4 a = point_data(seg);
                    if (seg + 1 >= point_count || a.z < .5) {
                        gl_Position = culled;
                        return;
                    }
                    vec4 ca = clip_pos(points_origin + a.xy, .5 * size_px);
                    vec4 cb = clip_pos(points_origin + point_data(seg + 1).xy, .5 * size_px);
                    if (ca.w < min_w && cb.w < min_w) {
                        gl_Position = culled;
                        return;
                    }
                    // clipping at the near plane
                    if (ca.w < min_w) ca = mix(ca, cb, (min_w - ca.w) / (cb.w - ca.w));
                    if (cb.w < min_w) cb = mix(cb, ca, (min_w - cb.w) / (ca.w - cb.w));
                    vec2 dir = (cb.xy / cb.w - ca.xy / ca.w) * viewport;
                    dir = length(dir) > 1e-6 ? normalize(dir) : vec2(1, 0);
                    vec4 p = offset.x > 0. ? cb : ca;
                    p.xy += vec2(-dir.y, dir.x) * offset.y * size_px / viewport * p.w;
                    gl_Position = p;
                    corner = offset;
                    point_index = seg;
                    point_kind = 0.;
                    return;
                }
                int i = gl_VertexID / 6;
                vec2 pos = marker_pos;
                float kind = 0.;
                if (mode == 1) {
                    vec4 d = point_data(i);
                    if (i >= point_count || (only_waypoints == 1 && d.z < .5)) {
                        gl_Position = culled;
                        return;
                    }
                    pos = points_origin + d.xy;
                    if (edit_points == 1) {
                        kind = d.z;
                        i = int(d.w);
                    }
                }
                vec4 p = clip_pos(pos, .5 * size_px);
                if (p.w < min_w) {
                    gl_Position = culled;
                    return;
                }
                p.xy += offset * size_px / viewport * p.w;
                gl_Position = p;
                corner = offset;
                point_index = i;
                point_kind = kind;
            }
            `;
            const fs = `#version 300 es
            precision highp float;
            precision highp int;
            in vec2 corner;
            flat in int point_index;
            flat in float point_kind;
            uniform int mode;
            uniform vec4 color;
            uniform vec4 outline_color;
            uniform int selected_index;
            out vec4 out_col;
            void main() {
                float r = mode == 0 ? abs(corner.y) : length(corner);
                if (r > 1.)
                    discard;
                float aa = fwidth(r);
                vec4 c = color;
                if (mode == 1 && point_kind > .5)
                    c = vec4(.15, .45, .95, 1.);
                if (mode == 1 && point_index == selected_index)
                    c = vec4(1., .85, 0., 1.);
                c = mix(c, outline_color, smoothstep(.62 - aa, .62 + aa, r));
                c.a *= 1. - smoothstep(1. - 1.5 * aa, 1., r);
                out_col = c;
            }
            `;
            this.program = initShaderProgram(gl, vs, fs);
            for (const name of ["points", "point_count", "points_origin", "grid_offset_pos", "cam_pos", "eye_offset", "view_proj", "viewport", "size_px", "lod_factor",
                                "max_mesh_level", "pixel_angle", "mode", "edit_points", "only_waypoints", "marker_pos", "color", "outline_color", "selected_index",
                                "virtual_heightmap_index", "virtual_heightmap"])
                this.uniforms[name] = gl.getUniformLocation(this.program, name);
            this.uniforms.heightmap_infos = gl.getUniformBlockIndex(this.program, "Infos_heightmap");
            const create_texture = () => {
                const t = gl.createTexture();
                gl.bindTexture(gl.TEXTURE_2D, t);
                gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
                gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
                return t;
            };
            this.line_texture = create_texture();
            this.edit_texture = create_texture();
            return this;
        },
        /** @brief uploads the points of the document if it changed since the last upload */
        update: function (doc) {
            if (doc.version == this.version)
                return;
            this.version = doc.version;
            const first = doc.segments.find(s => s.points.length);
            this.origin = first ? {x: first.points[0].x, y: first.points[0].y} : {x: 0, y: 0};
            const o = this.origin;
            let line = [], edit = [];
            this.segment_offsets = [];
            for (const seg of doc.segments) {
                this.segment_offsets.push(edit.length / 4);
                seg.points.forEach((p, i) => {
                    edit.push(p.x - o.x, p.y - o.y, seg.kind == "wpt" ? 1 : 0, edit.length / 4);
                    if (seg.kind == "wpt")
                        return;
                    const next = seg.points[i + 1];
                    line.push(p.x - o.x, p.y - o.y, next ? 1 : 0, 0);
                    if (!next)
                        return;
                    const pieces = Math.min(Math.ceil(GpxUtil.distance_m(p, next) / track_max_piece_m), 1000);
                    for (let k = 1; k < pieces; ++k)
                        line.push(p.x - o.x + (next.x - p.x) * k / pieces, p.y - o.y + (next.y - p.y) * k / pieces, 1, 0);
                });
            }
            this.line_count = line.length / 4;
            this.edit_count = edit.length / 4;
            this.upload_texture(this.line_texture, line);
            this.upload_texture(this.edit_texture, edit);
        },
        upload_texture: function (texture, values) {
            const gl = this.gl;
            const rows = Math.max(1, Math.ceil(values.length / 4 / track_texture_width));
            let data = new Float32Array(rows * track_texture_width * 4);
            data.set(values);
            gl.bindTexture(gl.TEXTURE_2D, texture);
            gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, track_texture_width, rows, 0, gl.RGBA, gl.FLOAT, data);
        },
        /** @returns {int} global index of point i in segment seg_index (as used for selected_index) */
        global_index: function (seg_index, i) {
            return this.segment_offsets[seg_index] + i;
        },
        /**
         * @param {{view_proj: Array, grid_offset_pos: {x, y}, cam_pos: Array, viewport: Array, lod_factor: float, max_mesh_level: int,
         *          eye_offset: float, pixel_angle: float, virtual_height_map: VirtualMap, show_handles: bool, selected_index: int, markers: Array}} p
         */
        draw: function (p) {
            const gl = this.gl;
            const u = this.uniforms;
            if (!this.line_count && !this.edit_count && !(p.markers && p.markers.length))
                return;
            gl.useProgram(this.program);
            p.virtual_height_map.bind_to_shader(gl.TEXTURE0, gl.TEXTURE1, u.heightmap_infos);
            gl.uniform1i(u.virtual_heightmap_index, 0);
            gl.uniform1i(u.virtual_heightmap, 1);
            gl.uniformBlockBinding(this.program, u.heightmap_infos, u.heightmap_infos);
            gl.uniformMatrix4fv(u.view_proj, false, p.view_proj);
            gl.uniform2f(u.grid_offset_pos, p.grid_offset_pos.x, p.grid_offset_pos.y);
            gl.uniform2f(u.points_origin, this.origin.x - p.grid_offset_pos.x, this.origin.y - p.grid_offset_pos.y);
            gl.uniform3f(u.cam_pos, p.cam_pos[0], p.cam_pos[1], p.cam_pos[2]);
            gl.uniform1f(u.eye_offset, p.eye_offset || 0);
            gl.uniform2f(u.viewport, p.viewport[0], p.viewport[1]);
            gl.uniform1f(u.lod_factor, p.lod_factor);
            gl.uniform1f(u.pixel_angle, p.pixel_angle);
            gl.uniform1i(u.max_mesh_level, p.max_mesh_level);
            gl.uniform1i(u.points, 6);
            gl.uniform1i(u.only_waypoints, 0);
            gl.uniform1i(u.selected_index, -1);
            gl.enable(gl.BLEND);
            gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
            gl.depthMask(false);
            gl.depthFunc(gl.LEQUAL);
            gl.activeTexture(gl.TEXTURE6);

            const track_color = this.track_color, track_outline = this.track_outline;
            const line_width = 6;
            if (this.line_count > 1) {
                gl.bindTexture(gl.TEXTURE_2D, this.line_texture);
                gl.uniform1i(u.point_count, this.line_count);
                gl.uniform1i(u.edit_points, 0);
                gl.uniform4fv(u.color, track_color);
                gl.uniform4fv(u.outline_color, track_outline);
                gl.uniform1f(u.size_px, line_width);
                // round joins first, the lines are drawn over their inner outline
                gl.uniform1i(u.mode, 1);
                gl.drawArrays(gl.TRIANGLES, 0, this.line_count * 6);
                gl.uniform1i(u.mode, 0);
                gl.drawArrays(gl.TRIANGLES, 0, (this.line_count - 1) * 6);
            }
            if (this.edit_count) {
                // handles of all points in edit mode, otherwise only the waypoints
                gl.bindTexture(gl.TEXTURE_2D, this.edit_texture);
                gl.uniform1i(u.point_count, this.edit_count);
                gl.uniform1i(u.edit_points, 1);
                gl.uniform1i(u.mode, 1);
                gl.uniform1i(u.only_waypoints, p.show_handles ? 0 : 1);
                gl.uniform1i(u.selected_index, p.selected_index);
                gl.uniform4fv(u.color, [1, 1, 1, 1]);
                gl.uniform4fv(u.outline_color, track_color);
                gl.uniform1f(u.size_px, p.handle_size || 14);
                gl.drawArrays(gl.TRIANGLES, 0, this.edit_count * 6);
                gl.uniform1i(u.only_waypoints, 0);
                gl.uniform1i(u.selected_index, -1);
            }
            // markers have a constant screen size
            for (const marker of p.markers || []) {
                gl.uniform1i(u.mode, 2);
                gl.uniform2f(u.marker_pos, marker.x - p.grid_offset_pos.x, marker.y - p.grid_offset_pos.y);
                gl.uniform4fv(u.color, marker.color);
                gl.uniform4fv(u.outline_color, [1, 1, 1, 1]);
                gl.uniform1f(u.size_px, 20);
                gl.drawArrays(gl.TRIANGLES, 0, 6);
            }
            gl.disable(gl.BLEND);
            gl.depthMask(true);
            gl.depthFunc(gl.LESS);
        },
    };
};
