"""
MeetLoop – Real-Time Moderation Microservice
FastAPI app exposing POST /analyze for black screen and vulgar gesture detection.
No external APIs – runs fully locally / self-hosted.

Uses MediaPipe Tasks API (new) instead of deprecated mp.solutions.
"""

import base64
import logging
import os
import urllib.request

import cv2
import mediapipe as mp
from mediapipe.tasks import python as mp_python
from mediapipe.tasks.python import vision as mp_vision
import numpy as np
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("moderation")

app = FastAPI(title="MeetLoop Moderation API", version="1.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["POST"],
    allow_headers=["*"],
)

# ── Model Download ───────────────────────────────────────────────────────────
MODEL_URL = "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/latest/hand_landmarker.task"
MODEL_PATH = os.path.join(os.path.dirname(__file__), "hand_landmarker.task")


def ensure_model():
    """Download the hand_landmarker.task model if it doesn't exist."""
    if not os.path.exists(MODEL_PATH):
        logger.info(f"Downloading hand_landmarker model to {MODEL_PATH} ...")
        urllib.request.urlretrieve(MODEL_URL, MODEL_PATH)
        logger.info("Model downloaded successfully!")


ensure_model()

# ── MediaPipe Hand Landmarker (new Tasks API) ────────────────────────────────
base_options = mp_python.BaseOptions(model_asset_path=MODEL_PATH)
hand_options = mp_vision.HandLandmarkerOptions(
    base_options=base_options,
    num_hands=2,
    min_hand_detection_confidence=0.6,
    min_tracking_confidence=0.5,
    running_mode=mp_vision.RunningMode.IMAGE,
)
hand_landmarker = mp_vision.HandLandmarker.create_from_options(hand_options)

# MediaPipe landmark indices
THUMB_TIP  = 4
INDEX_TIP  = 8
MIDDLE_TIP = 12
RING_TIP   = 16
PINKY_TIP  = 20

INDEX_MCP  = 5
MIDDLE_MCP = 9
RING_MCP   = 13
PINKY_MCP  = 17

INDEX_PIP  = 6
MIDDLE_PIP = 10
RING_PIP   = 14
PINKY_PIP  = 18

BLACK_SCREEN_THRESHOLD = 35  # mean brightness below this → black screen


# ── Request / Response Models ───────────────────────────────────────────────
class AnalyzeRequest(BaseModel):
    image: str  # base64-encoded JPEG


class AnalyzeResponse(BaseModel):
    safe: bool
    reason: str | None = None


# ── Helper: decode base64 image to OpenCV BGR array ─────────────────────────
def decode_image(b64_string: str) -> np.ndarray | None:
    """Decode a base64 string to an OpenCV BGR image."""
    try:
        if "," in b64_string:
            b64_string = b64_string.split(",", 1)[1]
        img_bytes = base64.b64decode(b64_string)
        np_arr = np.frombuffer(img_bytes, dtype=np.uint8)
        img = cv2.imdecode(np_arr, cv2.IMREAD_COLOR)
        return img
    except Exception:
        return None


# ── Detection 1: Black Screen ────────────────────────────────────────────────
def detect_black_screen(img: np.ndarray) -> bool:
    """
    Returns True if the frame appears to be black / camera covered.
    Converts to grayscale and checks mean pixel intensity.
    """
    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    mean_brightness = float(np.mean(gray))
    logger.debug(f"Mean brightness: {mean_brightness:.1f}")
    return mean_brightness < BLACK_SCREEN_THRESHOLD


# ── Detection 2: Vulgar Gesture (Middle Finger) ───────────────────────────────
def _is_finger_extended(landmarks, tip_idx: int, pip_idx: int, mcp_idx: int) -> bool:
    """
    A finger is considered extended if its tip is significantly above (lower Y)
    its PIP joint, and the PIP joint is above the MCP joint.
    Uses normalized Y coords (0 = top, 1 = bottom of image).
    """
    tip = landmarks[tip_idx]
    pip_j = landmarks[pip_idx]
    mcp = landmarks[mcp_idx]
    return tip.y < pip_j.y < mcp.y


def detect_vulgar_gesture(img: np.ndarray) -> bool:
    """
    Returns True if a 'middle finger' gesture is detected.
    Logic:
      - Middle finger tip must be raised (extended).
      - Index, ring, and pinky fingers must be curled (NOT extended).
      - Thumb state is ignored (it can be up or down).
    """
    rgb = cv2.cvtColor(img, cv2.COLOR_BGR2RGB)
    mp_image = mp.Image(image_format=mp.ImageFormat.SRGB, data=rgb)
    result = hand_landmarker.detect(mp_image)

    if not result.hand_landmarks:
        return False

    for hand_lm in result.hand_landmarks:
        middle_up = _is_finger_extended(hand_lm, MIDDLE_TIP, MIDDLE_PIP, MIDDLE_MCP)
        index_up  = _is_finger_extended(hand_lm, INDEX_TIP,  INDEX_PIP,  INDEX_MCP)
        ring_up   = _is_finger_extended(hand_lm, RING_TIP,   RING_PIP,   RING_MCP)
        pinky_up  = _is_finger_extended(hand_lm, PINKY_TIP,  PINKY_PIP,  PINKY_MCP)

        if middle_up and not index_up and not ring_up and not pinky_up:
            logger.info("Vulgar gesture detected!")
            return True

    return False


# ── Main Endpoint ─────────────────────────────────────────────────────────────
@app.post("/analyze", response_model=AnalyzeResponse)
async def analyze(request: AnalyzeRequest):
    try:
        img = decode_image(request.image)
        if img is None:
            logger.warning("Could not decode image, treating as safe.")
            return AnalyzeResponse(safe=True)

        # ① Check black screen first (cheapest operation)
        if detect_black_screen(img):
            return AnalyzeResponse(safe=False, reason="black_screen")

        # ② Check vulgar gesture (MediaPipe)
        if detect_vulgar_gesture(img):
            return AnalyzeResponse(safe=False, reason="vulgar_gesture")

        return AnalyzeResponse(safe=True)

    except Exception as e:
        logger.error(f"Analysis error: {e}", exc_info=True)
        # Fail open – don't block users on server errors
        return AnalyzeResponse(safe=True)


@app.get("/health")
async def health():
    return {"status": "ok", "service": "moderation"}


if __name__ == "__main__":
    import uvicorn
    uvicorn.run("main:app", host="0.0.0.0", port=8000, reload=False)
