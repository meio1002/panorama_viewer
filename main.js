import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";

const container = document.getElementById("viewer");
const fileInput = document.getElementById("fileInput");
const motionBtn = document.getElementById("motionBtn");
const motionStatus = document.getElementById("motionStatus");
const vrBtn = document.getElementById("vrBtn");
const vrHud = document.getElementById("vrHud");
const vrMessage = document.getElementById("vrMessage");
const exitVrBtn = document.getElementById("exitVrBtn");
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
const stereoCamera = new THREE.StereoCamera();
const gazeRaycaster = new THREE.Raycaster();
const gazeOrigin = new THREE.Vector3();
const gazeDirection = new THREE.Vector3();
const MOTION_CALIBRATION_SAMPLES = 4;
const MOTION_CALIBRATION_SETTLE_DELAY = 450;
const VR_MENU_DISTANCE = 4;
const VR_RETICLE_DISTANCE = 2.6;
const VR_GAZE_SELECT_DURATION = 1000;
const VR_MENU_OPEN_DURATION = 800;
const VR_MENU_OPEN_DOWN_Y = -0.55;
const VR_MENU_COOLDOWN = 700;
const VR_MENU_ITEM_WIDTH = 2.35;
const VR_MENU_ITEM_HEIGHT = 0.48;

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
let motionCalibrationPending = false;
let motionCalibrationSampleCount = 0;
let motionCalibrationReadyAt = 0;
let motionCalibrationCompleteMessage = "モーション操作中です。";
let vrModeEnabled = false;
let motionWasEnabledBeforeVr = false;
let fovBeforeVr = 75;
let vrMenuGroup;
let vrReticleGroup;
let vrReticleDot;
let vrReticleRing;
let vrMenuItems = [];
let vrMenuVisible = false;
let gazeTarget = null;
let gazeTargetStartedAt = 0;
let lookDownStartedAt = 0;
let vrMenuGestureCooldownUntil = 0;
let gazeActionCooldownUntil = 0;

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
  renderer.autoClear = false;
  container.appendChild(renderer.domElement);

  stereoCamera.eyeSep = 0.064;
  createVrHandsFreeControls();

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
  vrBtn.addEventListener("click", toggleVrMode);
  exitVrBtn.addEventListener("click", exitVrMode);
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
  camera.fov = vrModeEnabled ? 80 : 75;
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
  if (motionEnabled) {
    return true;
  }

  if (!canUseDeviceOrientation()) {
    setMotionStatus("この端末ではモーション操作を利用できません。", true);
    return false;
  }

  if (!window.isSecureContext) {
    setMotionStatus("モーション操作にはHTTPSまたはlocalhostが必要です。", true);
    return false;
  }

  try {
    const requestPermission = window.DeviceOrientationEvent.requestPermission;

    if (typeof requestPermission === "function") {
      const permission = await requestPermission.call(window.DeviceOrientationEvent);

      if (permission !== "granted") {
        setMotionStatus("センサー利用が許可されませんでした。", true);
        return false;
      }
    }
  } catch (error) {
    console.error("モーション操作の権限確認に失敗しました:", error);
    setMotionStatus("センサー利用を開始できませんでした。", true);
    return false;
  }

  latestOrientation = null;
  hasMotionSample = false;
  motionEnabled = true;
  controls.enabled = false;
  setMotionButtonState(true);
  setMotionStatus("センサー待機中です。端末を少し動かしてください。");

  window.addEventListener("deviceorientation", onDeviceOrientation);
  requestMotionCalibration(
    vrModeEnabled
      ? "横向きで正面を合わせています。端末を止めてください。"
      : "正面を合わせています。端末を止めてください。",
    "モーション操作中です。",
    vrModeEnabled ? MOTION_CALIBRATION_SETTLE_DELAY : 0
  );

  clearTimeout(sensorWaitTimer);
  sensorWaitTimer = window.setTimeout(() => {
    if (motionEnabled && !hasMotionSample) {
      setMotionStatus("センサー値を取得できません。ドラッグ操作に戻せます。", true);
    }
  }, 2200);

  return true;
}

function stopMotionTracking(message = "") {
  motionEnabled = false;
  hasMotionSample = false;
  latestOrientation = null;
  motionCalibrationPending = false;
  motionCalibrationSampleCount = 0;
  controls.enabled = true;
  clearTimeout(sensorWaitTimer);
  window.removeEventListener("deviceorientation", onDeviceOrientation);
  syncOrbitControlsToCamera();
  setMotionButtonState(false);
  setMotionStatus(message);
}

function onDeviceOrientation(event) {
  latestOrientation = event;
  screenOrientation = getScreenOrientation();

  if (!isUsableOrientation(event)) {
    return;
  }

  if (!hasMotionSample) {
    hasMotionSample = true;
  }

  updatePendingMotionCalibration();
}

function calibrateMotionView() {
  if (!isUsableOrientation(latestOrientation)) {
    setMotionStatus("現在の向きを取得してからリセットします。", true);
    return;
  }

  requestMotionCalibration(
    "正面を合わせています。端末を止めてください。",
    "モーション操作中です。"
  );
}

function requestMotionCalibration(message, completeMessage, delay = 0) {
  motionCalibrationPending = true;
  motionCalibrationSampleCount = 0;
  motionCalibrationReadyAt = performance.now() + delay;
  motionCalibrationCompleteMessage = completeMessage;
  setMotionStatus(message);
}

function updatePendingMotionCalibration() {
  if (!motionCalibrationPending || !isUsableOrientation(latestOrientation)) {
    return;
  }

  if (performance.now() < motionCalibrationReadyAt) {
    return;
  }

  motionCalibrationSampleCount += 1;

  if (motionCalibrationSampleCount < MOTION_CALIBRATION_SAMPLES) {
    return;
  }

  motionCalibrationPending = false;
  motionCalibrationSampleCount = 0;
  calibrateMotionViewNow();
  setMotionStatus(motionCalibrationCompleteMessage);
}

function calibrateMotionViewNow() {
  setDeviceQuaternion(deviceQuaternion, latestOrientation);
  motionCalibrationQuaternion.copy(deviceQuaternion).invert();
  updateCameraFromDeviceOrientation();
}

function updateCameraFromDeviceOrientation() {
  if (
    !motionEnabled ||
    motionCalibrationPending ||
    !isUsableOrientation(latestOrientation)
  ) {
    return;
  }

  setDeviceQuaternion(deviceQuaternion, latestOrientation);
  calibratedCameraQuaternion.multiplyQuaternions(
    motionCalibrationQuaternion,
    deviceQuaternion
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

  if (vrModeEnabled && message) {
    setVrMessage(message, isError);
  }
}

function onScreenOrientationChange() {
  screenOrientation = getScreenOrientation();

  if (motionEnabled) {
    requestMotionCalibration(
      vrModeEnabled
        ? "横向きに合わせています。端末を止めてください。"
        : "画面向きに合わせています。端末を止めてください。",
      "モーション操作中です。",
      MOTION_CALIBRATION_SETTLE_DELAY
    );
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

function createVrHandsFreeControls() {
  vrMenuGroup = new THREE.Group();
  vrMenuGroup.visible = false;

  const background = new THREE.Mesh(
    new THREE.PlaneGeometry(2.75, 2.2),
    new THREE.MeshBasicMaterial({
      color: 0x05090d,
      transparent: true,
      opacity: 0.64,
      depthTest: false,
      depthWrite: false
    })
  );
  background.position.z = -0.04;
  background.renderOrder = 10;
  vrMenuGroup.add(background);

  const title = createVrLabelMesh("視線メニュー", 1.9, 0.32, "#ffffff", 68);
  title.position.set(0, 0.88, 0.02);
  vrMenuGroup.add(title);

  vrMenuItems = [
    createVrMenuItem("正面リセット", "reset", 0.38),
    createVrMenuItem("メニューを閉じる", "close", -0.2),
    createVrMenuItem("VR終了", "exit", -0.78)
  ];

  vrMenuItems.forEach((item) => {
    vrMenuGroup.add(item);
  });

  scene.add(vrMenuGroup);

  vrReticleGroup = new THREE.Group();
  vrReticleGroup.visible = false;

  vrReticleRing = new THREE.Mesh(
    new THREE.RingGeometry(0.035, 0.046, 36),
    new THREE.MeshBasicMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: 0.82,
      depthTest: false,
      depthWrite: false,
      side: THREE.DoubleSide
    })
  );
  vrReticleRing.renderOrder = 30;

  vrReticleDot = new THREE.Mesh(
    new THREE.CircleGeometry(0.013, 24),
    new THREE.MeshBasicMaterial({
      color: 0x7cd0ff,
      transparent: true,
      opacity: 0.42,
      depthTest: false,
      depthWrite: false,
      side: THREE.DoubleSide
    })
  );
  vrReticleDot.position.z = 0.002;
  vrReticleDot.renderOrder = 31;

  vrReticleGroup.add(vrReticleRing, vrReticleDot);
  scene.add(vrReticleGroup);
}

function createVrMenuItem(label, action, y) {
  const item = new THREE.Mesh(
    new THREE.PlaneGeometry(VR_MENU_ITEM_WIDTH, VR_MENU_ITEM_HEIGHT),
    new THREE.MeshBasicMaterial({
      color: 0x101820,
      transparent: true,
      opacity: 0.82,
      depthTest: false,
      depthWrite: false,
      side: THREE.DoubleSide
    })
  );
  item.position.set(0, y, 0);
  item.renderOrder = 12;
  item.userData.action = action;
  item.userData.label = label;

  const labelMesh = createVrLabelMesh(label, 1.9, 0.26, "#ffffff", 70);
  labelMesh.position.z = 0.018;
  item.add(labelMesh);

  const progressBar = new THREE.Mesh(
    new THREE.PlaneGeometry(1, 0.035),
    new THREE.MeshBasicMaterial({
      color: 0x7cd0ff,
      transparent: true,
      opacity: 0.9,
      depthTest: false,
      depthWrite: false
    })
  );
  progressBar.visible = false;
  progressBar.position.set(-VR_MENU_ITEM_WIDTH / 2 + 0.12, -0.18, 0.02);
  progressBar.renderOrder = 14;
  item.add(progressBar);
  item.userData.progressBar = progressBar;

  return item;
}

function createVrLabelMesh(text, width, height, color, fontSize) {
  const canvas = document.createElement("canvas");
  canvas.width = 1024;
  canvas.height = 256;

  const context = canvas.getContext("2d");
  context.clearRect(0, 0, canvas.width, canvas.height);
  context.fillStyle = color;
  context.font = `700 ${fontSize}px system-ui, -apple-system, BlinkMacSystemFont, sans-serif`;
  context.textAlign = "center";
  context.textBaseline = "middle";
  context.fillText(text, canvas.width / 2, canvas.height / 2);

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;

  const material = new THREE.MeshBasicMaterial({
    map: texture,
    transparent: true,
    depthTest: false,
    depthWrite: false,
    side: THREE.DoubleSide
  });
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(width, height), material);
  mesh.renderOrder = 13;

  return mesh;
}

function enableVrHandsFreeControls() {
  vrReticleGroup.visible = true;
  closeVrMenu("下を見るとメニューを開けます。", false);
  vrMenuGestureCooldownUntil = performance.now() + VR_MENU_COOLDOWN;
}

function disableVrHandsFreeControls() {
  vrReticleGroup.visible = false;
  vrMenuGroup.visible = false;
  vrMenuVisible = false;
  lookDownStartedAt = 0;
  resetGazeSelection();
}

function updateVrHandsFreeControls(now) {
  if (!vrModeEnabled) {
    return;
  }

  const progress = vrMenuVisible
    ? updateVrMenuGaze(now)
    : updateVrMenuOpenGesture(now);

  updateVrReticle(progress, progress > 0);
}

function updateVrMenuOpenGesture(now) {
  if (now < vrMenuGestureCooldownUntil || motionCalibrationPending) {
    lookDownStartedAt = 0;
    return 0;
  }

  getCameraForward(gazeDirection);

  if (gazeDirection.y < VR_MENU_OPEN_DOWN_Y) {
    if (lookDownStartedAt === 0) {
      lookDownStartedAt = now;
      setVrMessage("下を見続けるとメニューを開きます。");
    }

    const progress = Math.min((now - lookDownStartedAt) / VR_MENU_OPEN_DURATION, 1);

    if (progress >= 1) {
      openVrMenu();
      return 0;
    }

    return progress;
  }

  if (lookDownStartedAt !== 0) {
    setVrMessage("下を見るとメニューを開けます。");
  }

  lookDownStartedAt = 0;
  return 0;
}

function updateVrMenuGaze(now) {
  if (now < gazeActionCooldownUntil) {
    resetGazeSelection();
    return 0;
  }

  camera.getWorldPosition(gazeOrigin);
  getCameraForward(gazeDirection);
  gazeRaycaster.set(gazeOrigin, gazeDirection);
  gazeRaycaster.far = VR_MENU_DISTANCE + 2;

  const intersections = gazeRaycaster.intersectObjects(vrMenuItems, false);
  const target = intersections[0]?.object ?? null;

  if (target !== gazeTarget) {
    gazeTarget = target;
    gazeTargetStartedAt = target ? now : 0;
    setVrMessage(target ? `${target.userData.label} を見続けて選択` : "項目を見続けると選択します。");
  }

  const progress = target
    ? Math.min((now - gazeTargetStartedAt) / VR_GAZE_SELECT_DURATION, 1)
    : 0;

  updateVrMenuItemVisuals(target, progress);

  if (target && progress >= 1) {
    executeVrMenuAction(target.userData.action);
    gazeActionCooldownUntil = now + VR_MENU_COOLDOWN;
    return 0;
  }

  return progress;
}

function openVrMenu() {
  positionVrMenuInFront();
  vrMenuVisible = true;
  vrMenuGroup.visible = true;
  lookDownStartedAt = 0;
  resetGazeSelection();
  setVrMessage("項目を見続けると選択します。");
}

function closeVrMenu(message = "下を見るとメニューを開けます。", useCooldown = true) {
  vrMenuVisible = false;
  vrMenuGroup.visible = false;
  lookDownStartedAt = 0;
  resetGazeSelection();

  if (useCooldown) {
    vrMenuGestureCooldownUntil = performance.now() + VR_MENU_COOLDOWN;
  }

  if (vrModeEnabled) {
    setVrMessage(message);
  }
}

function positionVrMenuInFront() {
  camera.getWorldPosition(gazeOrigin);
  getCameraForward(gazeDirection);
  vrMenuGroup.position.copy(gazeOrigin).addScaledVector(gazeDirection, VR_MENU_DISTANCE);
  vrMenuGroup.quaternion.copy(camera.quaternion);
}

function updateVrReticle(progress, isActive) {
  camera.getWorldPosition(gazeOrigin);
  getCameraForward(gazeDirection);
  vrReticleGroup.position.copy(gazeOrigin).addScaledVector(gazeDirection, VR_RETICLE_DISTANCE);
  vrReticleGroup.quaternion.copy(camera.quaternion);

  const scale = 1 + progress * 0.55;
  vrReticleRing.scale.setScalar(scale);
  vrReticleDot.scale.setScalar(1 + progress * 2.2);
  vrReticleRing.material.color.setHex(isActive ? 0x7cd0ff : 0xffffff);
  vrReticleDot.material.opacity = 0.38 + progress * 0.46;
}

function updateVrMenuItemVisuals(activeItem, progress) {
  vrMenuItems.forEach((item) => {
    const isActive = item === activeItem;
    const itemProgress = isActive ? progress : 0;
    const progressBar = item.userData.progressBar;
    const progressWidth = (VR_MENU_ITEM_WIDTH - 0.24) * itemProgress;

    item.material.color.setHex(isActive ? 0x17496a : 0x101820);
    item.material.opacity = isActive ? 0.95 : 0.82;
    item.scale.set(isActive ? 1.04 : 1, isActive ? 1.04 : 1, 1);

    progressBar.visible = itemProgress > 0;
    progressBar.scale.x = Math.max(progressWidth, 0.001);
    progressBar.position.x = -VR_MENU_ITEM_WIDTH / 2 + 0.12 + progressWidth / 2;
  });
}

function resetGazeSelection() {
  gazeTarget = null;
  gazeTargetStartedAt = 0;
  updateVrMenuItemVisuals(null, 0);
}

function executeVrMenuAction(action) {
  if (action === "reset") {
    if (motionEnabled) {
      calibrateMotionView();
      closeVrMenu("正面を合わせています。端末を止めてください。");
    } else {
      resetView();
      closeVrMenu("正面を合わせました。下を見るとメニューを開けます。");
    }
    return;
  }

  if (action === "close") {
    closeVrMenu();
    return;
  }

  if (action === "exit") {
    exitVrMode();
  }
}

function getCameraForward(target) {
  return target.set(0, 0, -1).applyQuaternion(camera.quaternion).normalize();
}

async function toggleVrMode() {
  if (vrModeEnabled) {
    exitVrMode();
    return;
  }

  await enterVrMode();
}

async function enterVrMode() {
  vrModeEnabled = true;
  motionWasEnabledBeforeVr = motionEnabled;
  fovBeforeVr = camera.fov;

  camera.fov = 80;
  updateCameraProjection();
  document.body.classList.add("is-vr");
  vrHud.hidden = false;
  setVrButtonState(true);
  enableVrHandsFreeControls();
  setVrMessage("下を見るとメニューを開けます。");

  requestVrPresentation();

  if (!motionEnabled) {
    const started = await startMotionTracking();

    if (!started) {
      setVrMessage("分割表示中です。視点操作にはセンサー許可が必要です。", true);
    }
  } else {
    requestMotionCalibration(
      "横向きで正面を合わせています。端末を止めてください。",
      "モーション操作中です。",
      MOTION_CALIBRATION_SETTLE_DELAY
    );
  }
}

function exitVrMode() {
  if (!vrModeEnabled) {
    return;
  }

  vrModeEnabled = false;
  camera.fov = fovBeforeVr;
  updateCameraProjection();
  document.body.classList.remove("is-vr");
  disableVrHandsFreeControls();
  vrHud.hidden = true;
  setVrButtonState(false);
  screen.orientation?.unlock?.();

  if (document.fullscreenElement) {
    const exitPromise = document.exitFullscreen?.();
    exitPromise?.catch?.(() => {});
  }

  if (!motionWasEnabledBeforeVr && motionEnabled) {
    stopMotionTracking("VR表示を終了しました。");
  } else {
    setMotionStatus("VR表示を終了しました。");
  }
}

function setVrButtonState(isActive) {
  vrBtn.textContent = isActive ? "VR終了" : "VRゴーグル";
  vrBtn.classList.toggle("is-active", isActive);
  vrBtn.setAttribute("aria-pressed", String(isActive));
}

function setVrMessage(message, isError = false) {
  vrMessage.textContent = message;
  vrMessage.classList.toggle("is-error", isError);
}

function requestVrPresentation() {
  const fullscreenPromise = document.fullscreenElement
    ? Promise.resolve()
    : document.documentElement.requestFullscreen?.();

  fullscreenPromise
    ?.then(() => {
      const lockPromise = screen.orientation?.lock?.("landscape");
      lockPromise?.catch?.(() => {});
    })
    .catch(() => {});
}

function toggleFullscreen() {
  if (!document.fullscreenElement) {
    document.documentElement.requestFullscreen?.();
  } else {
    document.exitFullscreen?.();
  }
}

function onResize() {
  renderer.setSize(window.innerWidth, window.innerHeight);
  updateCameraProjection();
}

function updateCameraProjection() {
  const viewWidth = vrModeEnabled ? window.innerWidth / 2 : window.innerWidth;

  camera.aspect = viewWidth / window.innerHeight;
  camera.updateProjectionMatrix();
}

function animate() {
  requestAnimationFrame(animate);

  if (motionEnabled) {
    updateCameraFromDeviceOrientation();
  } else {
    controls.update();
  }

  updateVrHandsFreeControls(performance.now());
  renderScene();
}

function renderScene() {
  const width = window.innerWidth;
  const height = window.innerHeight;

  if (!vrModeEnabled) {
    renderer.setScissorTest(false);
    renderer.setViewport(0, 0, width, height);
    renderer.clear();
    renderer.render(scene, camera);
    return;
  }

  const halfWidth = Math.floor(width / 2);

  camera.updateMatrixWorld();
  stereoCamera.update(camera);
  renderer.setScissorTest(true);

  renderer.setViewport(0, 0, halfWidth, height);
  renderer.setScissor(0, 0, halfWidth, height);
  renderer.clear();
  renderer.render(scene, stereoCamera.cameraL);

  renderer.setViewport(halfWidth, 0, width - halfWidth, height);
  renderer.setScissor(halfWidth, 0, width - halfWidth, height);
  renderer.clear();
  renderer.render(scene, stereoCamera.cameraR);

  renderer.setScissorTest(false);
}
