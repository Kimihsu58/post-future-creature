// levi_tex.gdshader - procedural surface textures ported from web LEVI_FRAG.
// Materials: 0 none, 1 rock, 2 bark, 3 soil, 4 vine, 5 skin, 6 chitin.
// Also: ground mottle patches, up-world ember cracks, alien pallid skin, rim fresnel.
// RULE: GDShader tokenizer REJECTS "#" comments (silent compile failure -> black/broken).
// Always use "//" in this file and keep it pure ASCII.
shader_type spatial;
// Ground sheets (seabed/litter/ridge) exported with downward winding -> backface-culled
// from above, leaving only the sky visible. Render both sides + flip normal on backfaces.
render_mode cull_disabled;

uniform int mat_id = 0;              // material branch selector (see above)
uniform vec3 tint = vec3(1.0);       // base color from Blender material (linear passthrough)
uniform float bump_amp = 0.16;       // micro-relief strength (per material)
uniform float mottle = 0.0;          // big ground color patches (seabed / red soil)
uniform float crack_ember = 0.0;     // glowing crack lines (up-world ground only)
uniform float rough = 0.85;
uniform float metal = 0.0;
uniform float rim_str = 0.0;         // fresnel edge glow (body skin, web uRim)
uniform vec3 rim_col = vec3(0.15, 0.95, 1.0);
uniform float alien = 0.0;           // evolved pallid human skin 0..1 (web uAlien)
uniform vec3 emissive = vec3(0.0);   // constant emission color (eyes etc)
uniform float emissive_energy = 0.0;
uniform float detail_fade = 0.026;   // high-frequency detail fade vs camera distance

varying vec3 opos;   // object-space position (texture sticks to the mesh)

// ---- procedural 3D value noise (pure math, no image textures) ----
float h31(vec3 p) {
	p = fract(p * 0.3183099 + vec3(0.71, 0.113, 0.419));
	p *= 17.0;
	return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
}

float vn(vec3 x) {
	vec3 i = floor(x), f = fract(x);
	f = f * f * (3.0 - 2.0 * f);
	return mix(mix(mix(h31(i), h31(i + vec3(1, 0, 0)), f.x),
	               mix(h31(i + vec3(0, 1, 0)), h31(i + vec3(1, 1, 0)), f.x), f.y),
	           mix(mix(h31(i + vec3(0, 0, 1)), h31(i + vec3(1, 0, 1)), f.x),
	               mix(h31(i + vec3(0, 1, 1)), h31(i + vec3(1, 1, 1)), f.x), f.y), f.z);
}

float fbm3(vec3 p) {
	float s = 0.500 * vn(p);
	s += 0.250 * vn(p * 2.03 + 11.3);
	s += 0.125 * vn(p * 4.11 + 23.7);
	return s * 1.143;
}

float fbm4(vec3 p) {
	float s = 0.500 * vn(p);
	s += 0.250 * vn(p * 2.03 + 11.3);
	s += 0.125 * vn(p * 4.11 + 23.7);
	s += 0.0625 * vn(p * 8.29 + 41.1);
	return s * 1.0667;
}

float ridge3(vec3 p) {
	float s = 0.55 * (1.0 - abs(2.0 * vn(p) - 1.0));
	s += 0.30 * (1.0 - abs(2.0 * vn(p * 2.13 + 7.7) - 1.0));
	s += 0.15 * (1.0 - abs(2.0 * vn(p * 4.41 + 19.1) - 1.0));
	return s;
}

// Material micro-height field (gradient -> normal bump). Axis note: web p5 is z-up,
// Godot is y-up, so web (x, y, z) axis roles map to Godot (x, z, y).
float matH(vec3 p) {
	if (mat_id > 5) { // chitin: plate bands + chitin grain (web sin(p.y*9), p5 y -> Godot z)
		return fbm3(p * 6.0) * 0.55 + (0.5 + 0.5 * sin(p.z * 9.0)) * 0.45;
	}
	if (mat_id > 4) { // skin: fine wrinkles + pore grain
		return fbm3(p * 7.5) * 0.55 + vn(p * 19.0) * 0.45;
	}
	if (mat_id > 3) { // vine: leathery blotches
		return fbm3(p * 3.6);
	}
	if (mat_id > 2) { // soil: clumps + fine sand
		return fbm3(p * 3.0) * 0.65 + vn(p * 12.0) * 0.35;
	}
	if (mat_id > 1) { // bark: vertical grooves (web z = trunk axis -> Godot y)
		vec3 q = vec3(p.x * 5.2, p.z * 5.2, p.y * 1.15);
		return vn(q) * 0.72 + vn(q * 2.6 + 5.0) * 0.28;
	}
	if (mat_id > 0) { // rock: slabs + fractures
		return fbm4(p * 1.55) * 0.68 + ridge3(p * 4.6) * 0.32;
	}
	return vn(p * 2.1); // default: same as web baseline
}

void vertex() {
	opos = VERTEX; // local space (env nodes are identity -> equals web world coords)
}

void fragment() {
	vec3 tp = opos;
	float dist = length(VERTEX); // camera distance (view space)
	float close = clamp(1.0 - dist * detail_fade, 0.0, 1.0);
	// Fragment NORMAL builtin is guaranteed VIEW space (Godot docs) -> derive world normal
	// from it directly. No vertex-stage space guessing.
	vec3 Nv = NORMAL;                                     // pristine view-space normal
	if (!FRONT_FACING) {
		Nv = -Nv;   // inverted-winding mesh (ground sheets): light the side we actually see
	}
	vec3 N = normalize((INV_VIEW_MATRIX * vec4(Nv, 0.0)).xyz); // -> world for bump frame
	vec3 base = tint;

	// base color micro-variation (web line 157)
	base *= 0.90 + 0.20 * vn(tp * 0.55 + 13.7);

	// ground mottle: huge patches of value + warm hue drift (web lines 159-166)
	if (mottle > 0.5) {
		float m1 = vn(tp * 0.09 + 71.0);
		float m2 = vn(tp * 0.33 + 37.0);
		float m3 = vn(tp * 1.45 + 17.0);
		base *= 0.50 + 0.92 * m1;
		base = mix(base, base * vec3(1.24, 0.94, 0.76), m2 * 0.60 * (1.0 - alien * 0.75));
		base *= 0.92 + 0.16 * m3;
	}

	// material color textures (web lines 168-225)
	if (mat_id > 0) {
		if (mat_id == 1) {
			// rock: broad slabs + crack network + mineral speckle
			float broad = fbm3(tp * 0.75 + 5.0);
			float crack = smoothstep(0.72, 0.97, ridge3(tp * 2.6 + 17.0));
			base *= 0.62 + 0.72 * broad;
			base = mix(base, base * vec3(1.12, 1.03, 0.88), smoothstep(0.55, 0.82, broad));
			base *= 1.0 - 0.68 * crack;
			float speck = vn(tp * 26.0 + 61.0);
			base += vec3(0.15, 0.145, 0.13) * step(0.968, speck) * close;
			base *= 1.0 - 0.35 * step(speck, 0.030) * close;
		} else if (mat_id == 2) {
			// bark: vertical grooves + deep dead-wood cracks + weathered ridges
			vec3 q = vec3(tp.x * 4.6, tp.z * 4.6, tp.y * 1.05);
			float grooves = vn(q);
			float fine = vn(q * 3.1 + 9.0);
			float crackT = smoothstep(0.76, 0.98, ridge3(vec3(tp.x * 3.0, tp.z * 3.0, tp.y * 0.8) + 31.0));
			base *= 0.52 + 0.80 * grooves;
			base *= 0.86 + 0.26 * fine;
			base *= 1.0 - 0.55 * crackT;
			base = mix(base, base * vec3(1.16, 1.07, 0.90), smoothstep(0.62, 0.88, grooves) * 0.55);
		} else if (mat_id == 3) {
			// soil: clumps + fine sand + embedded grit pebbles
			float clump = fbm3(tp * 2.2 + 13.0);
			float sand = vn(tp * 17.0 + 3.0);
			float grit = vn(tp * 9.0 + 77.0);
			base *= 0.70 + 0.56 * clump;
			base *= 0.90 + 0.20 * sand * close;
			base = mix(base, base * 1.40 + vec3(0.02), step(0.905, grit) * close * 0.8);
		} else if (mat_id == 4) {
			// vine skin: dark rot blotches + pores
			float blotch = fbm3(tp * 2.8 + 27.0);
			float pores = vn(tp * 14.0 + 5.0);
			base *= 0.66 + 0.58 * blotch;
			base = mix(base, base * vec3(0.70, 0.60, 0.60), smoothstep(0.62, 0.9, blotch) * 0.7);
			base *= 0.93 + 0.14 * pores * close;
		} else if (mat_id == 5) {
			// skin: pores + micro wrinkles + blotchy blood tone
			float pore = vn(tp * 24.0 + 7.0);
			float micro = fbm3(tp * 9.0 + 61.0);
			float tone = fbm3(tp * 1.7 + 88.0);
			base *= 0.84 + 0.28 * micro;
			base *= 0.95 + 0.10 * pore * close;
			base = mix(base, base * vec3(1.10, 0.90, 0.88), smoothstep(0.55, 0.82, tone) * 0.68);
			base = mix(base, base * vec3(0.86, 0.92, 0.97), smoothstep(0.55, 0.82, 1.0 - tone) * 0.40);
		} else {
			// chitin: horizontal plate bands + grain + longitudinal scratches
			float plate = 0.5 + 0.5 * sin(tp.z * 9.0);
			float seam = smoothstep(0.84, 1.0, plate);
			float chitin = fbm3(tp * 6.5 + 43.0);
			float scratch = ridge3(vec3(tp.x * 9.0, tp.z * 1.3, tp.y * 9.0) + 66.0);
			base *= 0.72 + 0.48 * chitin;
			base *= 1.0 - 0.58 * seam;
			base *= 1.0 - 0.32 * smoothstep(0.80, 0.97, scratch) * close;
			base = mix(base, base * vec3(1.28, 1.14, 1.06), smoothstep(0.55, 0.88, chitin) * 0.45);
		}
	}

	// evolved pallid skin (web uAlien): wychina-style corpse pallor + vessel net
	float vein_glow = 0.0;
	vec3 rim_c = rim_col;
	if (alien > 0.001) {
		vec3 pallid = vec3(0.71, 0.66, 0.63);
		float wrinkle = vn(tp * 5.5 + 23.0);
		float vein = smoothstep(0.58, 0.86, vn(tp * 2.8 + 51.0));
		float pore2 = vn(tp * 24.0 + 15.0);
		float blot2 = fbm3(tp * 1.9 + 95.0);
		base = mix(base, pallid * (0.70 + 0.44 * wrinkle), alien * 0.92);
		base *= 1.0 - 0.10 * pore2 * alien;
		base = mix(base, base * vec3(1.05, 0.88, 0.87), smoothstep(0.58, 0.85, blot2) * 0.5 * alien);
		base = mix(base, vec3(0.22, 0.03, 0.05), vein * alien * 0.90);
		rim_c = mix(rim_c, vec3(0.95, 0.82, 0.76), alien * 0.70);
		vein_glow = vein * alien * 0.35;
	}

	// micro bump: material height gradient perturbs the world normal (web lines 127-146)
	float bump_fade = clamp(1.0 - dist * 0.018, 0.0, 1.0);
	if (bump_amp > 0.0 && bump_fade > 0.01) {
		vec3 up_ref = abs(N.y) < 0.99 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0);
		vec3 T = normalize(cross(N, up_ref));
		vec3 B = cross(N, T);
		float e = 0.09;
		float h0 = matH(tp);
		float hT = matH(tp + T * e);
		float hB = matH(tp + B * e);
		N = normalize(N - (T * (hT - h0) + B * (hB - h0)) / e * bump_amp * bump_fade);
	}

	// world normal -> view space (world->view = VIEW_MATRIX, NOT INV_VIEW!)
	NORMAL = normalize((VIEW_MATRIX * vec4(N, 0.0)).xyz);
	ALBEDO = base;
	ROUGHNESS = rough;
	METALLIC = metal;

	// fresnel rim glow from the PRISTINE view-space normal (same space as Vv -> no transform)
	vec3 Vv = normalize(-VERTEX); // fragment VERTEX is view space -> Vv points to camera
	float fres = pow(1.0 - abs(dot(normalize(Nv), Vv)), 3.0);
	vec3 emis = emissive * emissive_energy;
	emis += rim_c * fres * rim_str;
	emis += vec3(0.55, 0.07, 0.10) * vein_glow * 0.50;

	// up-world ember cracks: hairline glowing seams that slowly breathe (web lines 267-274)
	if (crack_ember > 0.5) {
		float cr = 1.0 - abs(vn(tp * 1.55 + 91.0) * 2.0 - 1.0);
		cr = smoothstep(0.93, 0.998, cr);
		cr *= smoothstep(0.42, 0.62, vn(tp * 0.48 + 55.0));
		float breathe = 0.70 + 0.30 * sin(TIME * 1.2 + tp.x * 0.21 + tp.z * 0.17);
		float near_fade = clamp(1.0 - dist * 0.030, 0.0, 1.0);
		emis += vec3(1.0, 0.34, 0.09) * cr * breathe * near_fade * 0.34;
	}
	EMISSION = emis;
}
