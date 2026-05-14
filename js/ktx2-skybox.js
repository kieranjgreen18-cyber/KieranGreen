/**
 * ktx2-skybox.js
 * Loads a KTX2 equirectangular image and injects it as the skybox + environment
 * of a <model-viewer> element using model-viewer's internal scene API.
 *
 * Usage — add to your <model-viewer>:
 *   data-ktx2-skybox="assets/images/your-file.ktx2"
 *
 * Then load this script after model-viewer:
 *   <script type="module" src="js/ktx2-skybox.js"></script>
 */

const VIEWER_SEL = 'model-viewer[data-ktx2-skybox]';

// Retrieve a symbol from an object by its description string.
function getSym(obj, description) {
  return Object.getOwnPropertySymbols(obj).find(s => s.description === description);
}

async function injectKTX2Skybox(viewer) {
  const ktx2Url = viewer.dataset.ktx2Skybox;
  if (!ktx2Url) return;

  // Wait for the element to upgrade and the model to load.
  await customElements.whenDefined('model-viewer');
  await new Promise(resolve => {
    if (viewer.loaded) { resolve(); return; }
    const onLoad = () => { viewer.removeEventListener('load', onLoad); resolve(); };
    viewer.addEventListener('load', onLoad);
    setTimeout(resolve, 5000); // safety fallback
  });
  await new Promise(r => requestAnimationFrame(r));

  // ── Reach model-viewer internals via symbol lookup ──────────────────────
  // jx = Symbol('scene')     → the ModelScene (Three.js Scene subclass)
  // $x = Symbol('renderer')  → the Renderer wrapper; .threeRenderer = WebGLRenderer
  const sceneSym    = getSym(viewer, 'scene');
  const rendererSym = getSym(viewer, 'renderer');

  if (!sceneSym || !rendererSym) {
    console.warn('[ktx2-skybox] Could not find scene/renderer symbols on model-viewer element.');
    return;
  }

  const modelScene      = viewer[sceneSym];
  const rendererWrapper = viewer[rendererSym];
  const threeRenderer   = rendererWrapper?.threeRenderer;

  if (!modelScene || !threeRenderer) {
    console.warn('[ktx2-skybox] scene or threeRenderer is null.');
    return;
  }

  // ── Import KTX2Loader from the same Three.js version model-viewer bundles ─
  // model-viewer v4.0.0 ships three r163.
  const THREE_VERSION = '0.163.0';
  const CDN = `https://cdn.jsdelivr.net/npm/three@${THREE_VERSION}`;

  let KTX2Loader, PMREMGenerator, EquirectangularReflectionMapping;
  try {
    ({ KTX2Loader } = await import(`${CDN}/examples/jsm/loaders/KTX2Loader.js`));
    ({ PMREMGenerator, EquirectangularReflectionMapping } =
      await import(`${CDN}/build/three.module.js`));
  } catch (e) {
    console.warn('[ktx2-skybox] Failed to import Three.js loaders:', e);
    return;
  }

  // ── Load the KTX2 file ───────────────────────────────────────────────────
  const loader = new KTX2Loader();
  loader.setTranscoderPath(`${CDN}/examples/jsm/libs/basis/`);
  loader.detectSupport(threeRenderer);

  let texture;
  try {
    texture = await loader.loadAsync(ktx2Url);
  } catch (e) {
    console.warn('[ktx2-skybox] KTX2 load failed:', e);
    loader.dispose();
    return;
  }

  texture.mapping = EquirectangularReflectionMapping;

  // ── Generate PMREM for IBL (same as model-viewer does for HDR files) ─────
  const pmrem  = new PMREMGenerator(threeRenderer);
  pmrem.compileEquirectangularShader();
  const envMap = pmrem.fromEquirectangular(texture).texture;
  pmrem.dispose();

  // ── Inject via model-viewer's own scene API ──────────────────────────────
  // setEnvironmentAndSkybox(envTexture, skyboxTexture) sets IBL + background.
  modelScene.setEnvironmentAndSkybox(envMap, texture);
  modelScene.queueRender();

  loader.dispose();
  console.info('[ktx2-skybox] Injected →', ktx2Url);
}

document.querySelectorAll(VIEWER_SEL).forEach(viewer => {
  injectKTX2Skybox(viewer).catch(e => console.warn('[ktx2-skybox] Error:', e));
});
