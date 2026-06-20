// Vistalia — gl install smoke test (Path B prerequisite).
//
// Purpose: validate that the `gl` npm package (headless WebGL 1.0)
// installs cleanly on the Render.com Linux container and can create a
// usable WebGL context. This is the critical risk for the depth pipeline
// build plan — if gl can't run on the worker, Path B doesn't ship.
//
// Run on the deployed worker:
//   npm run smoke:gl
//
// Expected output:
//   ✓ gl module imported
//   ✓ context created (640x480)
//   ✓ basic GL calls work (clear, viewport, readPixels)
//   ✓ shader compiled
//   ✓ triangle rendered + read back
//
// If any step fails on Render.com, document the error and we'll need to
// pivot to either: (a) a different headless GL package, or (b) running
// the depth renderer in a Python sidecar via Open3D.

import process from "node:process";

function ok(msg) { console.log(`\x1b[32m✓\x1b[0m ${msg}`); }
function fail(msg, err) {
  console.error(`\x1b[31m✗\x1b[0m ${msg}`);
  if (err) console.error(err.stack || err.message || err);
  process.exit(1);
}

let createGL;
try {
  ({ default: createGL } = await import("gl"));
  ok("gl module imported");
} catch (err) {
  fail("gl module failed to import (npm install gl probably failed)", err);
}

const WIDTH = 640;
const HEIGHT = 480;

let gl;
try {
  gl = createGL(WIDTH, HEIGHT, { preserveDrawingBuffer: true });
  if (!gl) throw new Error("createGL returned null/undefined");
  ok(`context created (${WIDTH}x${HEIGHT})`);
} catch (err) {
  fail("failed to create WebGL context", err);
}

try {
  gl.viewport(0, 0, WIDTH, HEIGHT);
  gl.clearColor(0.0, 0.0, 1.0, 1.0); // solid blue
  gl.clear(gl.COLOR_BUFFER_BIT);

  const buf = new Uint8Array(WIDTH * HEIGHT * 4);
  gl.readPixels(0, 0, WIDTH, HEIGHT, gl.RGBA, gl.UNSIGNED_BYTE, buf);

  // A blue clear should give us (0, 0, 255, 255) at every pixel.
  if (buf[0] !== 0 || buf[1] !== 0 || buf[2] !== 255 || buf[3] !== 255) {
    throw new Error(`pixel readback wrong: got [${buf[0]},${buf[1]},${buf[2]},${buf[3]}], expected [0,0,255,255]`);
  }
  ok("basic GL calls work (clear, viewport, readPixels)");
} catch (err) {
  fail("basic GL operations failed", err);
}

// Compile a trivial vertex + fragment shader pair to confirm the GLSL
// compiler is wired correctly (this catches Mesa-version mismatches that
// look fine at context creation but blow up at compile time).
try {
  const vshSrc = "attribute vec2 a; void main(){gl_Position=vec4(a,0.0,1.0);}";
  const fshSrc = "precision mediump float; void main(){gl_FragColor=vec4(1.0,0.0,0.0,1.0);}";

  const vsh = gl.createShader(gl.VERTEX_SHADER);
  gl.shaderSource(vsh, vshSrc);
  gl.compileShader(vsh);
  if (!gl.getShaderParameter(vsh, gl.COMPILE_STATUS)) {
    throw new Error(`vertex shader compile failed: ${gl.getShaderInfoLog(vsh)}`);
  }

  const fsh = gl.createShader(gl.FRAGMENT_SHADER);
  gl.shaderSource(fsh, fshSrc);
  gl.compileShader(fsh);
  if (!gl.getShaderParameter(fsh, gl.COMPILE_STATUS)) {
    throw new Error(`fragment shader compile failed: ${gl.getShaderInfoLog(fsh)}`);
  }

  const prog = gl.createProgram();
  gl.attachShader(prog, vsh);
  gl.attachShader(prog, fsh);
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
    throw new Error(`program link failed: ${gl.getProgramInfoLog(prog)}`);
  }
  ok("shader compiled");

  // Render a triangle (covers most of the framebuffer) and verify the red
  // fragment shader output landed on the right pixels.
  const verts = new Float32Array([-0.8, -0.8,  0.8, -0.8,  0.0, 0.8]);
  const vbo = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
  gl.bufferData(gl.ARRAY_BUFFER, verts, gl.STATIC_DRAW);

  gl.clearColor(0, 0, 0, 1);
  gl.clear(gl.COLOR_BUFFER_BIT);
  gl.useProgram(prog);
  const loc = gl.getAttribLocation(prog, "a");
  gl.enableVertexAttribArray(loc);
  gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
  gl.drawArrays(gl.TRIANGLES, 0, 3);

  const pixel = new Uint8Array(4);
  // Sample the middle of the framebuffer — should be red.
  gl.readPixels(WIDTH / 2, HEIGHT / 2, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
  if (pixel[0] < 200 || pixel[1] > 50 || pixel[2] > 50) {
    throw new Error(`triangle render readback wrong: got [${pixel[0]},${pixel[1]},${pixel[2]},${pixel[3]}], expected red-dominant`);
  }
  ok("triangle rendered + read back");
} catch (err) {
  fail("shader / draw test failed", err);
}

console.log("");
console.log("\x1b[32mAll gl smoke tests passed.\x1b[0m The depth pipeline can use headless WebGL on this environment.");
