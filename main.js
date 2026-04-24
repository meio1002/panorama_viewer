import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";

const container = document.getElementById("viewer");
const fileInput = document.getElementById("fileInput");
const motionBtn = document.getElementById("motionBtn");
const motionStatus = document.getElementById("motionStatus");
const resetBtn = document.getElementById("resetBtn");
const fullscreenBtn = document.getElementById("fullscreenBtn");

const zee = new THREE.Vector3(0, 0, 1);
const deviceEuler = new THREE.Euler();
const deviceQuaternion = new THREE.Quaternion();
const screenQuaternion = new THREE.Quaternion();
const deviceTransformQuaternion = new THREE.Quaternion(
  -Math.sqrt(0.5),
  0,
  0,
  Math.sqrt(0.5)
);
const motionCalibrationQuaternion = new THREE.Quaternion();
const calibratedCameraQuaternion = new THREE.Quaternion();
const forwardDirection = new THREE.Vector3();

let scene;
let camera;
let renderer;
let controls;
let sphere;
let currentTexture;
let latestOrientation = null;
let motionEnabled = false;
let hasMotionSample = false;
let screenOrientation = 0;
let sensorWaitTimer = 0;

init();
loadPanorama("./assets/panorama.jpeg");
animate();

function init() {
  scene = new THREE.Scene();

  camera = new THREE.PerspectiveCamera(
    75,
    window.innerWidth / window.innerHeight,
    0.1,
    2000
  );

  // 完全に原点だと操作開始時に不安定になる場合があるため、わずかに前へ置く
  camera.position.set(0, 0, 0.1);

  renderer = new THREE.WebGLRenderer({
    antialias: true,
    powerPreference: "high-performance"
  });

  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(window.innerWidth, window.innerHeight);
  container.appendChild(renderer.domElement);

  controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.06;
  controls.enablePan = false;
  controls.minDistance = 0.1;
  controls.maxDistance = 0.1;
  controls.rotateSpeed = -0.35;

  // ズームはカメラのFOVで制御
  controls.enableZoom = false;
  renderer.domElement.addEventListener("wheel", onMouseWheel, { passive: false });

  window.addEventListener("resize", onResize);
  window.addEventListener("orientationchange", onScreenOrientationChange);
  screen.orientation?.addEventListener?.("change", onScreenOrientationChange);

  fileInput.addEventListener("change", onFileSelected);
  motionBtn.addEventListener("click", toggleMotionTracking);
  resetBtn.addEventListener("click", resetView);
  fullscreenBtn.addEventListener("click", toggleFullscreen);

  screenOrientation = getScreenOrientation();
  updateMotionAvailability();
}

function loadPanorama(url) {
  const loader = new THREE.TextureLoader();

  loader.load(
    url,
    (texture) => {
      texture.colorSpace = THREE.SRGBColorSpace;
      texture.minFilter = THREE.LinearFilter;
      texture.magFilter = THREE.LinearFilter;

      setPanoramaTexture(texture);
    },
    undefined,
    (error) => {
      console.error("パノラマ画像の読み込みに失敗しました:", error);
      alert("画像の読み込みに失敗しました。");
    }
  );
}

function setPanoramaTexture(texture) {
  if (currentTexture) {
    currentTexture.dispose();
  }

  currentTexture = texture;

  if (!sphere) {
    const geometry = new THREE.SphereGeometry(500, 128, 96);

    // 球体の内側から見るためにX方向を反転
    geometry.scale(-1, 1, 1);

    const material = new THREE.MeshBasicMaterial({
      map: currentTexture
    });

    sphere = new THREE.Mesh(geometry, material);
    scene.add(sphere);
  } else {
    sphere.material.map = currentTexture;
    sphere.material.needsUpdate = true;
  }

  resetView();
}

function onFileSelected(event) {
  const file = event.target.files?.[0];
  if (!file) return;

  const objectUrl = URL.createObjectURL(file);
  const image = new Image();

  image.onload = () => {
    const ratio = image.width / image.height;

    // 360° equirectangular画像は通常2:1。少し余裕を持って判定。
    if (ratio < 1.8 || ratio > 2.2) {
      const ok = confirm(
        `この画像は ${image.width}×${image.height} で、2:1比率ではありません。\n` +
        "表示はできますが、歪む可能性があります。続行しますか？"
      );

      if (!ok) {
        URL.revokeObjectURL(objectUrl);
        fileInput.value = "";
        return;
      }
    }

    loadPanorama(objectUrl);
  };

  image.onerror = () => {
    URL.revokeObjectURL(objectUrl);
    alert("画像を読み込めませんでした。");
  };

  image.src = objectUrl;
}

function onMouseWheel(event) {
  event.preventDefault();

  const delta = Math.sign(event.deltaY);
  camera.fov = THREE.MathUtils.clamp(camera.fov + delta * 3, 35, 100);
  camera.updateProjectionMatrix();
}

function resetView() {
  camera.fov = 75;
  camera.updateProjectionMatrix();

  if (motionEnabled) {
    calibrateMotionView();
    return;
  }

  camera.position.set(0, 0, 0.1);
  controls.target.set(0, 0, 0);
  controls.update();
}

async function toggleMotionTracking() {
  if (motionEnabled) {
    stopMotionTracking("モーション操作を停止しました。");
    return;
  }

  await startMotionTracking();
}

async function startMotionTracking() {
  if (!canUseDeviceOrientation()) {
    setMotionStatus("この端末ではモーション操作を利用できません。", true);
    return;
  }

  if (!window.isSecureContext) {
    setMotionStatus("モーション操作にはHTTPSまたはlocalhostが必要です。", true);
    return;
  }

  try {
    const requestPermission = window.DeviceOrientationEvent.requestPermission;

    if (typeof requestPermission === "function") {
      const permission = await requestPermission.call(window.DeviceOrientationEvent);

      if (permission !== "granted") {
        setMotionStatus("センサー利用が許可されませんでした。", true);
        return;
      }
    }
  } catch (error) {
    console.error("モーション操作の権限確認に失敗しました:", error);
    setMotionStatus("センサー利用を開始できませんでした。", true);
    return;
  }

  latestOrientation = null;
  hasMotionSample = false;
  motionEnabled = true;
  controls.enabled = false;
  setMotionButtonState(true);
  setMotionStatus("センサー待機中です。端末を少し動かしてください。");

  window.addEventListener("deviceorientation", onDeviceOrientation);
  clearTimeout(sensorWaitTimer);
  sensorWaitTimer = window.setTimeout(() => {
    if (motionEnabled && !hasMotionSample) {
      setMotionStatus("センサー値を取得できません。ドラッグ操作に戻せます。", true);
    }
  }, 2200);
}

function stopMotionTracking(message = "") {
  motionEnabled = false;
  hasMotionSample = false;
  latestOrientation = null;
  controls.enabled = true;
  clearTimeout(sensorWaitTimer);
  window.removeEventListener("deviceorientation", onDeviceOrientation);
  syncOrbitControlsToCamera();
  setMotionButtonState(false);
  setMotionStatus(message);
}

function onDeviceOrientation(event) {
  latestOrientation = event;

  if (!isUsableOrientation(event)) {
    return;
  }

  if (!hasMotionSample) {
    hasMotionSample = true;
    calibrateMotionView();
    setMotionStatus("モーション操作中です。");
  }
}

function calibrateMotionView() {
  if (!isUsableOrientation(latestOrientation)) {
    setMotionStatus("現在の向きを取得してからリセットします。", true);
    return;
  }

  setDeviceQuaternion(deviceQuaternion, latestOrientation);
  motionCalibrationQuaternion.copy(deviceQuaternion).invert();
  updateCameraFromDeviceOrientation();
}

function updateCameraFromDeviceOrientation() {
  if (!motionEnabled || !isUsableOrientation(latestOrientation)) {
    return;
  }

  setDeviceQuaternion(deviceQuaternion, latestOrientation);
  calibratedCameraQuaternion.multiplyQuaternions(
    deviceQuaternion,
    motionCalibrationQuaternion
  );
  camera.quaternion.copy(calibratedCameraQuaternion);
  camera.position.set(0, 0, 0.1);
}

function setDeviceQuaternion(quaternion, orientation) {
  const alpha = typeof orientation.alpha === "number"
    ? THREE.MathUtils.degToRad(orientation.alpha)
    : 0;
  const beta = THREE.MathUtils.degToRad(orientation.beta);
  const gamma = THREE.MathUtils.degToRad(orientation.gamma);

  deviceEuler.set(beta, alpha, -gamma, "YXZ");
  quaternion.setFromEuler(deviceEuler);
  quaternion.multiply(deviceTransformQuaternion);
  quaternion.multiply(screenQuaternion.setFromAxisAngle(zee, -screenOrientation));
}

function isUsableOrientation(orientation) {
  return (
    orientation &&
    typeof orientation.beta === "number" &&
    typeof orientation.gamma === "number"
  );
}

function canUseDeviceOrientation() {
  return "DeviceOrientationEvent" in window;
}

function updateMotionAvailability() {
  if (canUseDeviceOrientation()) {
    return;
  }

  motionBtn.disabled = true;
  setMotionStatus("この端末ではモーション操作を利用できません。", true);
}

function setMotionButtonState(isActive) {
  motionBtn.textContent = isActive ? "モーション停止" : "モーション開始";
  motionBtn.classList.toggle("is-active", isActive);
  motionBtn.setAttribute("aria-pressed", String(isActive));
}

function setMotionStatus(message, isError = false) {
  motionStatus.textContent = message;
  motionStatus.hidden = message === "";
  motionStatus.classList.toggle("is-error", isError);
}

function onScreenOrientationChange() {
  screenOrientation = getScreenOrientation();

  if (motionEnabled && hasMotionSample) {
    calibrateMotionView();
  }
}

function getScreenOrientation() {
  if (typeof screen.orientation?.angle === "number") {
    return THREE.MathUtils.degToRad(screen.orientation.angle);
  }

  if (typeof window.orientation === "number") {
    return THREE.MathUtils.degToRad(window.orientation);
  }

  return 0;
}

function syncOrbitControlsToCamera() {
  forwardDirection.set(0, 0, -1).applyQuaternion(camera.quaternion);
  controls.target.copy(camera.position).addScaledVector(forwardDirection, 0.1);
  controls.update();
}

function toggleFullscreen() {
  if (!document.fullscreenElement) {
    document.documentElement.requestFullscreen?.();
  } else {
    document.exitFullscreen?.();
  }
}

function onResize() {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();

  renderer.setSize(window.innerWidth, window.innerHeight);
}

function animate() {
  requestAnimationFrame(animate);

  if (motionEnabled) {
    updateCameraFromDeviceOrientation();
  } else {
    controls.update();
  }

  renderer.render(scene, camera);
}
