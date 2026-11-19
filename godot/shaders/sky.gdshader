// sky.gdshader - procedural sky dome: vertical gradient + FBM storm clouds + lightning flash
// IMPORTANT: GDShader tokenizer does NOT accept "#" comments (silent compile failure -> black sky).
// Always use "//" here, even for comments. Keep ASCII to be safe.
// Colors/cloud amount are set by main.gd per environment (up = red storm / sea = deep blue).
shader_type sky;
render_mode disable_fog;   // fog (depth + volumetric) must not wash the sky

uniform vec3 horizon_color : source_color = vec3(0.30, 0.09, 0.07);
uniform vec3 zenith_color : source_color = vec3(0.015, 0.01, 0.03);
uniform vec3 ground_color : source_color = vec3(0.05, 0.02, 0.02);
uniform vec3 cloud_color : source_color = vec3(0.10, 0.035, 0.035);
uniform vec3 flash_color : source_color = vec3(1.0, 0.45, 0.35);
uniform float flash : hint_range(0.0, 1.0) = 0.0;       // lightning brightness (driven by main.gd)
uniform float cloud_amount : hint_range(0.0, 1.0) = 0.6; // cloud coverage
uniform float cloud_scale = 1.1;                          // cloud size
uniform float wind_speed = 0.012;                         // cloud drift speed

float hash(vec2 p) {
	return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
}

float noise(vec2 p) {
	vec2 i = floor(p), f = fract(p);
	vec2 u = f * f * (3.0 - 2.0 * f);
	return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), u.x),
	           mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x), u.y);
}

float fbm(vec2 p) {
	float v = 0.0, a = 0.5;
	for (int i = 0; i < 5; i++) {
		v += a * noise(p);
		p = p * 2.03 + vec2(19.7, 7.3);
		a *= 0.5;
	}
	return v;
}

void sky() {
	vec3 d = EYEDIR;               // normalized view direction of current pixel
	float h = d.y;                 // elevation -1..1 (Godot Y-up)

	// vertical gradient: horizon -> zenith; below horizon blends into ground haze (no seam)
	vec3 col;
	if (h >= 0.0) {
		col = mix(horizon_color, zenith_color, pow(h, 0.5));
	} else {
		col = mix(horizon_color, ground_color, min(1.0, -h * 2.5));
	}

	// planar-projected FBM clouds (stretched near horizon = perspective depth)
	if (cloud_amount > 0.001 && h > 0.015) {
		vec2 uv = d.xz / (h + 0.12) * cloud_scale;
		uv += TIME * wind_speed * vec2(1.0, 0.6);
		float n = fbm(uv);
		float cover = smoothstep(1.0 - cloud_amount, 1.0 - cloud_amount + 0.35, n);
		float lit = fbm(uv + vec2(0.35, -0.25));          // offset sample = cheap lit face
		vec3 cc = cloud_color * (0.55 + 0.9 * lit);
		col = mix(col, cc, cover * smoothstep(0.0, 0.12, h));
	}

	// lightning: whole sky brightens (stronger near horizon); COLOR may exceed 1 -> bloom catches it
	float boost = 0.45 + 0.55 * (1.0 - abs(h));
	col += flash_color * flash * boost * 1.6;
	COLOR = col * (1.0 + flash * 1.5);
}
