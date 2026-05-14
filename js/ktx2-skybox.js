/**
 * ktx2-skybox.js
 * ──────────────────────────────────────────────────────────────────────────
 * Loads a KTX2 equirectangular image and injects it as both the background
 * (skybox) and environment map of a <model-viewer> element, replacing the
 * built-in skybox-image pipeline which only accepts HDR/JPG/PNG.
 *
 * HOW IT WORKS
 * ─────────────────────────────────────────────────────────────────────────
 * model-viewer bundles Three.js internally. Once the element upgrades we can
 * reach its renderer and scene via the modelViewer.renderer and
 * modelViewer.scene (or the underlying ThreeJS scene exposed through the
 * unofficial but stable modelViewer.model.scene). We piggyback on the KTX2Loader
 * that Three.js r152+ ships (it's available on the global THREE object that
 * model-viewer exposes as window.__THREE__ or via import-map on newer builds).
 *
 * USAGE
 * ─────────────────────────────────────────────────────────────────────────
 * 1.  Remove (or leave blank) the skybox-image attribute on <model-viewer>.
 * 2.  Add the data attributes below to your <model-viewer> element:
 *
 *       data-ktx2-skybox="assets/images/151_hdrmaps_com_free_4K.ktx2"
 *       data-ktx2-basis-url="https://cdn.jsdelivr.net/npm/three@0.176.0/examples/jsm/libs/basis/"
 *
 *     The basis URL points to the BasisU WASM transcoder that KTX2Loader needs.
 *     You can self-host it from three/examples/jsm/libs/basis/ if you prefer.
 *
 * 3.  Load this script AFTER model-viewer:
 *
 *       <script type="module" src="js/ktx2-skybox.js"></script>
 *
 * ──────────────────────────────────────────────────────────────────────────
 */

const VIEWER_SEL   = 'model-viewer[data-ktx2-skybox]';
const DEFAULT_BASIS = 'https://cdn.jsdelivr.net/npm/three@0.176.0/examples/jsm/libs/basis/';

/**
 * Wait until customElements.whenDefined('model-viewer') resolves AND the
 * element's `load` event has fired (meaning the internal Three.js scene is
 * fully initialised and the renderer is available).
 */
async function injectKTX2Skybox(viewer) {
  const ktx2Url   = viewer.dataset.ktx2Skybox;
  const basisUrl  = viewer.dataset.ktx2BasisUrl || DEFAULT_BASIS;
  if (!ktx2Url) return;

  // ── 1. Wait for model-viewer's internal scene to be ready ───────────────
  await customElements.whenDefined('model-viewer');

  // model-viewer exposes `modelIsVisible` once the GLB + environment are
  // both loaded. We wait for either the 'load' event or a 2s safety timeout,
  // then wait one more frame so Three.js has committed its first render.
  await new Promise(resolve => {
    if (viewer.loaded) { resolve(); return; }
    const onLoad = () => { viewer.removeEventListener('load', onLoad); resolve(); };
    viewer.addEventListener('load', onLoad);
    // safety fallback — if the model is slow / errors, still attempt injection
    setTimeout(resolve, 4000);
  });
  await new Promise(r => requestAnimationFrame(r));

  // ── 2. Reach the internal Three.js renderer + scene ─────────────────────
  // model-viewer exposes these through semi-private properties. The property
  // names have been stable across v3–v4 but may change in future major versions.
  // We try multiple known paths for resilience.
  const renderer = (
    viewer.renderer?.threeRenderer          // MV v3+
    ?? viewer[Object.getOwnPropertySymbols(viewer)
        ?.find(s => viewer[s]?.threeRenderer)]?.threeRenderer   // fallback symbol search
  );

  const scene = (
    viewer.scene                            // public alias added in MV v4
    ?? viewer.model?.scene                  // MV v3
    ?? viewer[Object.getOwnPropertySymbols(viewer)
        ?.find(s => viewer[s]?.environment !== undefined)]?.scene
  );

  if (!renderer || !scene) {
    console.warn('[ktx2-skybox] Could not access Three.js renderer/scene. ' +
      'Falling back — set skybox-image to an HDR instead.');
    return;
  }

  // ── 3. Import KTX2Loader from Three.js (model-viewer re-exports THREE) ──
  // MV v4 exposes the bundled Three.js version on window.__THREE__
  // (set by model-viewer's module bootstrap). We use a dynamic import of the
  // same Three.js version to get the loaders.
  let KTX2Loader, PMREMGenerator, EquirectangularReflectionMapping, SRGBColorSpace, LinearSRGBColorSpace;
  try {
    // model-viewer v4 pins three r163; match the CDN version to the bundled one
    // to avoid duplicate Three.js instances corrupting shared state.
    const threeVersion = window.__THREE__ ?? '0.176.0';
    const base = `https://cdn.jsdelivr.net/npm/three@${threeVersion}/examples/jsm/`;
    ({ KTX2Loader } = await import(base + 'loaders/KTX2Loader.js'));
    ({
      PMREMGenerator,
      EquirectangularReflectionMapping,
      SRGBColorSpace,
      LinearSRGBColorSpace,
    } = await import(`https://cdn.jsdelivr.net/npm/three@${threeVersion}/build/three.module.js`));
  } catch (e) {
    console.warn('[ktx2-skybox] Three.js loader import failed:', e);
    return;
  }

  // ── 4. Load the KTX2 texture ─────────────────────────────────────────────
  const loader = new KTX2Loader();
  loader.setTranscoderPath(basisUrl);
  loader.detectSupport(renderer);

  let texture;
  try {
    texture = await loader.loadAsync(ktx2Url);
  } catch (e) {
    console.warn('[ktx2-skybox] KTX2 load failed:', e);
    loader.dispose();
    return;
  }

  // KTX2 files from HDRMaps are typically stored as RGBA16F / RGBE.
  // Mark as equirectangular so Three.js maps it correctly onto the sphere.
  texture.mapping = EquirectangularReflectionMapping;

  // ── 5. Generate a PMREM (pre-filtered mipmap radiance env map) ───────────
  // This is what model-viewer does internally for HDR files — it converts the
  // equirect into a cube-based PMREM used for IBL/reflections.
  const pmrem    = new PMREMGenerator(renderer);
  pmrem.compileEquirectangularShader();
  const envMap   = pmrem.fromEquirectangular(texture).texture;
  pmrem.dispose();

  // ── 6. Inject into the scene ─────────────────────────────────────────────
  // Set as both background (visible skybox) and environment (IBL source).
  // model-viewer re-uses the same texture for both when skybox-image is set,
  // so we match that behaviour.
  scene.background    = texture;
  scene.environment   = envMap;

  // Trigger a re-render so the new background is visible immediately.
  // model-viewer uses requestAnimationFrame internally; nudging it is enough.
  try { viewer.dismissPoster(); } catch (_) {}

  loader.dispose();

  console.info('[ktx2-skybox] KTX2 skybox injected successfully →', ktx2Url);
}

// ── Boot: find all tagged viewers and inject ─────────────────────────────
document.querySelectorAll(VIEWER_SEL).forEach(viewer => {
  injectKTX2Skybox(viewer).catch(e =>
    console.warn('[ktx2-skybox] Unhandled error:', e)
  );
});
