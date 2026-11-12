"""Remindly — Full-featured reminder app backend.

Features:
- JWT + bcrypt auth (email + phone)
- Reminders CRUD with scheduling via APScheduler
- Contacts (saved persons)
- Multi-channel delivery: Expo push, WhatsApp, SMS, Email
- Graceful fallback when 3rd-party credentials are absent
"""
import os
import random
import re
import logging
import asyncio
import uuid
import hashlib
import hmac
import html as html_lib
import json
import math
from contextlib import asynccontextmanager
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import List, Optional, Literal
from urllib.parse import quote

import bcrypt
import httpx
import jwt
import pytz
from apscheduler.schedulers.asyncio import AsyncIOScheduler
from apscheduler.triggers.date import DateTrigger
from dotenv import load_dotenv
from fastapi import APIRouter, Depends, FastAPI, HTTPException, Header, Request, Response, WebSocket, WebSocketDisconnect, status
from fastapi.middleware.cors import CORSMiddleware
from motor.motor_asyncio import AsyncIOMotorClient
from pydantic import BaseModel, EmailStr, Field, field_validator
from pymongo import ReturnDocument
from pymongo.errors import DuplicateKeyError

ROOT_DIR = Path(__file__).parent
load_dotenv(ROOT_DIR / ".env")

# ---------------- Logging ----------------
logging.basicConfig(
    level=logging.INFO, format="%(asctime)s - %(name)s - %(levelname)s - %(message)s"
)
logger = logging.getLogger("remindly")

# ---------------- Config ----------------
MONGO_URL = os.environ["MONGO_URL"]
DB_NAME = os.environ["DB_NAME"]
JWT_SECRET = os.environ["JWT_SECRET_KEY"]
JWT_ALG = os.environ.get("JWT_ALGORITHM", "HS256")
ACCESS_EXPIRES_MIN = int(os.environ.get("ACCESS_TOKEN_EXPIRE_MINUTES", "10080"))

TWILIO_SID = os.environ.get("TWILIO_ACCOUNT_SID", "")
TWILIO_TOKEN = os.environ.get("TWILIO_AUTH_TOKEN", "")
TWILIO_PHONE = os.environ.get("TWILIO_PHONE_NUMBER", "")
TWILIO_WA_FROM = os.environ.get("TWILIO_WHATSAPP_FROM", "")
TWILIO_WA_CONTENT_SID = os.environ.get("TWILIO_WA_CONTENT_SID", "")
RESEND_KEY = os.environ.get("RESEND_API_KEY", "")
RESEND_FROM = os.environ.get("RESEND_FROM_EMAIL", "onboarding@resend.dev")

# Base URL of the web app — used for clickable email links (custom app schemes
# like remindly:// are not clickable in email clients). Override via env if needed.
WEB_APP_URL = os.environ.get("WEB_APP_URL", "https://www.rymind.in").rstrip("/")

# Payments. Mobile purchases go through RevenueCat (App Store / Play billing);
# web purchases go through Razorpay. Each side stays disabled until its keys are set.
REVENUECAT_SECRET_KEY = os.environ.get("REVENUECAT_SECRET_KEY", "")
REVENUECAT_WEBHOOK_AUTH = os.environ.get("REVENUECAT_WEBHOOK_AUTH", "")
RAZORPAY_KEY_ID = os.environ.get("RAZORPAY_KEY_ID", "")
RAZORPAY_KEY_SECRET = os.environ.get("RAZORPAY_KEY_SECRET", "")
RAZORPAY_WEBHOOK_SECRET = os.environ.get("RAZORPAY_WEBHOOK_SECRET", "")

# ---------------- DB ----------------
# Tuned pool + timeouts: keep warm connections (less churn / fewer dropped SYNs) and
# fail fast on a bad connection instead of hanging ~30s (default serverSelectionTimeoutMS).
client = AsyncIOMotorClient(
    MONGO_URL,
    serverSelectionTimeoutMS=5000,
    connectTimeoutMS=5000,
    socketTimeoutMS=10000,
    maxPoolSize=50,
    minPoolSize=5,
    retryWrites=True,
)
db = client[DB_NAME]

# ---------------- Scheduler ----------------
scheduler = AsyncIOScheduler(timezone=pytz.UTC)


# ---------------- Real-time user WebSocket registry ----------------
# Maps user_id -> set of active WebSocket connections (for live sync across
# all signed-in clients — mobile app + web companion).
_user_sockets: dict[str, set[WebSocket]] = {}


async def broadcast_to_user(user_id: str, payload: dict) -> None:
    """Send a JSON payload to every active socket belonging to the given user.
    Failures are swallowed so a dead websocket never breaks an API response."""
    if not user_id:
        return
    sockets = list(_user_sockets.get(user_id, set()))
    for ws in sockets:
        try:
            await ws.send_json(payload)
        except Exception as e:
            logger.debug("[ws/user] send failed for %s: %s", user_id, e)
            try:
                _user_sockets.get(user_id, set()).discard(ws)
            except Exception:
                pass


# ---------------- Models ----------------
class UserSignup(BaseModel):
    email: EmailStr
    phone: str = Field(..., min_length=6)
    password: str = Field(..., min_length=6)
    full_name: str = Field(..., min_length=1)
    country_code: str = Field(default="+91")
    # Optional opt-in for marketing / promotional emails (sent via external tools).
    marketing_consent: bool = Field(default=False)
    # Verification no longer required at signup — it happens in-app after a grace period.


class SendCodeIn(BaseModel):
    target: Literal["phone", "email"]
    value: str = Field(..., min_length=3)
    country_code: str = Field(default="+91")


class VerifyCodeIn(BaseModel):
    target: Literal["phone", "email"]
    value: str = Field(..., min_length=3)
    code: str = Field(..., min_length=6, max_length=6)


class UserLogin(BaseModel):
    email: EmailStr
    password: str


class UserOut(BaseModel):
    id: str
    email: str
    phone: str
    full_name: str
    country_code: str
    expo_push_token: Optional[str] = None
    created_at: str
    phone_verified: bool = True
    email_verified: bool = True
    marketing_consent: bool = False
    plan: str = "free"  # effective plan: free while the credit balance is empty
    credits: float = 0


class MarketingUnsubscribeIn(BaseModel):
    email: EmailStr


class VerifyPhoneIn(BaseModel):
    phone: str = Field(..., min_length=4)  # raw national number, no country code
    country_code: str = Field(default="+91")
    code: str = Field(..., min_length=6, max_length=6)


class VerifyEmailIn(BaseModel):
    email: EmailStr
    code: str = Field(..., min_length=6, max_length=6)


class ProfileUpdateIn(BaseModel):
    full_name: Optional[str] = None
    phone: Optional[str] = None
    country_code: Optional[str] = None
    email: Optional[EmailStr] = None


class TokenOut(BaseModel):
    access_token: str
    token_type: str = "bearer"
    user: UserOut


class PushTokenIn(BaseModel):
    token: str


Channel = Literal["push", "whatsapp", "email", "sms"]


class ReminderTarget(BaseModel):
    # who is the reminder for
    is_self: bool = True
    name: Optional[str] = None
    phone: Optional[str] = None  # for whatsapp/sms
    email: Optional[str] = None  # for email


class ReminderCreate(BaseModel):
    title: str = Field(..., min_length=1)
    message: Optional[str] = ""
    scheduled_at: str  # ISO string with timezone
    timezone: str = "UTC"
    channels: List[Channel]
    repeat_count: int = Field(default=1, ge=-1, le=9999)
    repeat_interval_hours: float = Field(default=24, ge=0.016, le=43800)  # 1 minute (1/60h ≈ 0.0167) .. 5 years
    lead_minutes: int = Field(default=0, ge=0)  # reminder N minutes before
    target: ReminderTarget
    contact_id: Optional[str] = None


class ReminderUpdate(BaseModel):
    title: Optional[str] = None
    message: Optional[str] = None
    scheduled_at: Optional[str] = None
    channels: Optional[List[Channel]] = None
    repeat_count: Optional[int] = Field(default=None, ge=-1, le=9999)
    repeat_interval_hours: Optional[float] = Field(default=None, ge=0.016, le=43800)
    lead_minutes: Optional[int] = Field(default=None, ge=0)


class ReminderOut(BaseModel):
    id: str
    user_id: str
    title: str
    message: str
    scheduled_at: str
    timezone: str
    channels: List[str]
    repeat_count: int
    repeat_interval_hours: float
    lead_minutes: int
    target: ReminderTarget
    status: str
    triggered_count: int
    created_at: str
    next_fire_at: Optional[str] = None
    last_fired_at: Optional[str] = None
    pending_channels: List[str] = []
    needs_user_send: bool = False
    contact_id: Optional[str] = None
    contact_missing: bool = False  # was for a saved contact that has since been deleted


class MarkSentIn(BaseModel):
    channel: Literal["whatsapp", "email", "sms"]


class StatusUpdate(BaseModel):
    action: Literal["complete", "cancel", "postpone"]
    postpone_minutes: Optional[int] = 30


def _validate_contact_phone(value: Optional[str]) -> str:
    """A contact must carry a usable phone number (7–15 digits, optional + prefix)."""
    if value is None or not str(value).strip():
        raise ValueError("Phone number is required")
    cleaned = str(value).strip()
    digits = "".join(c for c in cleaned if c.isdigit())
    if len(digits) < 7:
        raise ValueError("Enter a valid phone number")
    if len(digits) > 15:
        raise ValueError("Phone number is too long")
    return cleaned


class ContactCreate(BaseModel):
    name: str = Field(..., min_length=1)
    phone: str = Field(..., min_length=1)
    email: Optional[str] = None

    @field_validator("phone")
    @classmethod
    def _check_phone(cls, v: str) -> str:
        return _validate_contact_phone(v)


class ContactUpdate(BaseModel):
    name: str = Field(..., min_length=1)
    phone: str = Field(..., min_length=1)
    email: Optional[str] = None

    @field_validator("phone")
    @classmethod
    def _check_phone(cls, v: str) -> str:
        return _validate_contact_phone(v)


class ContactOut(BaseModel):
    id: str
    user_id: str
    name: str
    phone: Optional[str] = None
    email: Optional[str] = None
    created_at: str
    active_reminders: int = 0


# ---------------- Security helpers ----------------
def hash_password(p: str) -> str:
    return bcrypt.hashpw(p.encode(), bcrypt.gensalt(rounds=10)).decode()


def _phone_suffix(value: Optional[str]) -> Optional[str]:
    """Normalize any phone string to last-10-digits for cross-user matching.
    Strips '+', spaces, dashes, parentheses, country-code prefix if present.
    Returns None for empty / too-short numbers."""
    if not value:
        return None
    digits = "".join(c for c in str(value) if c.isdigit())
    if len(digits) < 7:
        return None
    return digits[-10:] if len(digits) >= 10 else digits


def verify_password(p: str, h: str) -> bool:
    try:
        return bcrypt.checkpw(p.encode(), h.encode())
    except Exception:
        return False


def create_access_token(user_id: str) -> str:
    payload = {
        "sub": user_id,
        "exp": datetime.now(timezone.utc) + timedelta(minutes=ACCESS_EXPIRES_MIN),
        "iat": datetime.now(timezone.utc),
    }
    return jwt.encode(payload, JWT_SECRET, algorithm=JWT_ALG)


async def get_current_user(authorization: Optional[str] = Header(None)) -> dict:
    if not authorization or not authorization.lower().startswith("bearer "):
        raise HTTPException(status_code=401, detail="Missing bearer token")
    token = authorization.split(" ", 1)[1].strip()
    try:
        payload = jwt.decode(token, JWT_SECRET, algorithms=[JWT_ALG])
        user_id = payload.get("sub")
    except jwt.PyJWTError:
        raise HTTPException(status_code=401, detail="Invalid token")
    user = await db.users.find_one({"id": user_id}, {"_id": 0, "password_hash": 0})
    if not user:
        raise HTTPException(status_code=401, detail="User not found")
    return user


# ---------------- Senders (all graceful) ----------------
async def send_expo_push(token: str, title: str, body: str, data: dict | None = None) -> bool:
    if not token:
        logger.info("[push] skip — no token")
        return False
    try:
        async with httpx.AsyncClient(timeout=10) as http:
            resp = await http.post(
                "https://exp.host/--/api/v2/push/send",
                json={
                    "to": token,
                    "sound": "default",
                    "title": title,
                    "body": body,
                    "data": data or {},
                },
                headers={"Content-Type": "application/json"},
            )
        logger.info("[push] -> %s %s", resp.status_code, resp.text[:120])
        if resp.status_code != 200:
            return False
        # Expo returns HTTP 200 even for per-ticket errors — inspect the body.
        try:
            ticket = (resp.json() or {}).get("data") or {}
        except Exception:
            ticket = {}
        if isinstance(ticket, dict) and ticket.get("status") == "error":
            err = (ticket.get("details") or {}).get("error")
            logger.warning("[push] ticket error: %s", err)
            if err == "DeviceNotRegistered":
                # Token is dead (app uninstalled / token rotated) — drop it everywhere.
                try:
                    await db.users.update_many(
                        {"expo_push_token": token}, {"$set": {"expo_push_token": None}}
                    )
                except Exception as e:
                    logger.debug("[push] failed clearing dead token: %s", e)
            return False
        return True
    except Exception as e:
        logger.warning("[push] failed: %s", e)
        return False


def _twilio_ready() -> bool:
    return bool(TWILIO_SID and TWILIO_TOKEN)


async def send_whatsapp(
    to_phone: str,
    body: str,
    template_vars: Optional[dict] = None,
) -> bool:
    """Send WhatsApp message via Twilio.

    If TWILIO_WA_CONTENT_SID is configured AND template_vars provided, sends
    using the approved Content Template (required for proactive sends to users
    outside the 24-hour conversation window).

    Otherwise falls back to free-form text (works only inside the 24-hr window
    or for sandbox-joined numbers).
    """
    if not _twilio_ready() or not TWILIO_WA_FROM:
        logger.info("[whatsapp MOCK] to=%s body=%s", to_phone, body[:80])
        return False
    try:
        import json as _json
        from twilio.rest import Client  # type: ignore

        use_template = bool(TWILIO_WA_CONTENT_SID and template_vars)

        def _send():
            c = Client(TWILIO_SID, TWILIO_TOKEN)
            to = to_phone if to_phone.startswith("whatsapp:") else f"whatsapp:{to_phone}"
            if use_template:
                c.messages.create(
                    from_=TWILIO_WA_FROM,
                    to=to,
                    content_sid=TWILIO_WA_CONTENT_SID,
                    content_variables=_json.dumps(template_vars),
                )
            else:
                c.messages.create(from_=TWILIO_WA_FROM, to=to, body=body)

        await asyncio.to_thread(_send)
        logger.info(
            "[whatsapp] sent to=%s via=%s", to_phone, "template" if use_template else "freeform"
        )
        return True
    except Exception as e:
        logger.warning("[whatsapp] failed: %s", e)
        return False


async def send_sms(to_phone: str, body: str) -> bool:
    if not _twilio_ready() or not TWILIO_PHONE:
        logger.info("[sms MOCK] to=%s body=%s", to_phone, body[:80])
        return False
    try:
        from twilio.rest import Client  # type: ignore

        def _send():
            c = Client(TWILIO_SID, TWILIO_TOKEN)
            # smart_encoded swaps look-alike Unicode (curly quotes, long dashes) for GSM-7
            # characters, so a typed apostrophe doesn't double the segment count.
            return c.messages.create(from_=TWILIO_PHONE, to=to_phone, body=body, smart_encoded=True)

        msg = await asyncio.to_thread(_send)
        logger.info("[sms] queued to=%s sid=%s status=%s", to_phone, getattr(msg, "sid", None), getattr(msg, "status", None))
        return True
    except Exception as e:
        # TwilioRestException carries Twilio's error code (e.g. 21608 unverified on trial,
        # 21408 region not enabled, 21211 invalid number) — log it so failures are diagnosable.
        logger.warning("[sms] failed to=%s code=%s: %s", to_phone, getattr(e, "code", None), e)
        return False


async def send_email(to_email: str, subject: str, html: str) -> bool:
    if not RESEND_KEY:
        logger.info("[email MOCK] to=%s subject=%s", to_email, subject)
        return False
    try:
        import resend  # type: ignore

        resend.api_key = RESEND_KEY

        def _send():
            resend.Emails.send({
                "from": RESEND_FROM,
                "to": [to_email],
                "subject": subject,
                "html": html,
            })

        await asyncio.to_thread(_send)
        return True
    except Exception as e:
        logger.warning("[email] failed: %s", e)
        return False


# ---------------- Plans & credits ----------------
# One-time credit packs from the client's plan sheet. Credits never expire.
# 1 credit = $0.001 of provider cost; the pack prices carry the margin.
# Balances are stored as integer tenths of a credit (credits_tenths) so 0.4-credit
# emails add up exactly instead of drifting like floats would.
FREE_ACTIVE_LIMIT = 10
PAID_CHANNELS = ("whatsapp", "sms", "email")
CREDIT_USD = 0.001

PLANS: list[dict] = [
    {
        "id": "free", "name": "Free", "credits": 0, "price_usd": 0, "price_inr": 0,
        "product_id": None, "recommended": False,
        "tagline": "For individuals trying Rymind",
        "features": ["App notifications only", f"Up to {FREE_ACTIVE_LIMIT} active reminders"],
    },
    {
        "id": "starter", "name": "Starter", "credits": 1000, "price_usd": 5.99, "price_inr": 499,
        "product_id": "rymind_credits_1000", "recommended": False,
        "tagline": "Best for sending occasional reminders.",
        "features": ["1,000 credits", "Notifications, WhatsApp, SMS and email", "Unlimited active reminders"],
    },
    {
        "id": "popular", "name": "Popular", "credits": 4000, "price_usd": 19.99, "price_inr": 1699,
        "product_id": "rymind_credits_4000", "recommended": True,
        "tagline": "Best for regular personal use.",
        "features": ["4,000 credits", "Notifications, WhatsApp, SMS and email", "Unlimited active reminders"],
    },
    {
        "id": "business", "name": "Business", "credits": 20000, "price_usd": 89.99, "price_inr": 7499,
        "product_id": "rymind_credits_20000", "recommended": False,
        "tagline": "Best for businesses sending reminders to customers and teams.",
        "features": ["20,000 credits", "Notifications, WhatsApp, SMS and email", "Unlimited active reminders"],
    },
]
PACKS = {p["id"]: p for p in PLANS if p["credits"] > 0}
PRODUCT_TO_PACK = {p["product_id"]: p["id"] for p in PACKS.values()}
# Existing users at launch get the smallest pack once, as a welcome gift.
WELCOME_GIFT_PACK = "starter"


def _credits_tenths(u: dict) -> int:
    return int(u.get("credits_tenths") or 0)


def _tenths_to_credits(t: int) -> float:
    return round(t / 10, 1)


def _effective_plan(u: dict) -> str:
    """A user is on Free whenever their balance is empty; otherwise they hold the
    tier of the last pack they bought (or were gifted)."""
    if _credits_tenths(u) <= 0:
        return "free"
    plan = u.get("plan")
    return plan if plan in PACKS else WELCOME_GIFT_PACK


def _billing_currency(u: dict) -> str:
    """Web checkout charges Indian users in INR and everyone else in USD.
    (App Store / Play localize prices themselves.)"""
    return "INR" if (u.get("country_code") or "+91") == "+91" else "USD"


# ---------------- Per-country message rates ----------------
# Paid sends always go to the account holder's own phone/email (self reminders, and
# the creator's copy of "someone else" reminders), so cost depends on the user's
# own country. India is domestic and uses the sheet's fixed rates; every other
# country is priced from that country's real provider cost.
DOMESTIC_ISO = "IN"
DOMESTIC_CREDITS = {"sms": 80, "whatsapp": 6}
EMAIL_TENTHS = 4  # 0.4 credits, same everywhere
# The sheet's flat international rates, used only for countries we can't price.
INTL_DEFAULT_CREDITS = {"sms": 500, "whatsapp": 60}

# (dial code, ISO country, display name). Longest dial-code prefix wins.
COUNTRY_DIAL_CODES: list[tuple[str, str, str]] = [
    ("+1", "US", "US & Canada"), ("+7", "RU", "Russia"), ("+20", "EG", "Egypt"),
    ("+27", "ZA", "South Africa"), ("+30", "GR", "Greece"), ("+31", "NL", "Netherlands"),
    ("+32", "BE", "Belgium"), ("+33", "FR", "France"), ("+34", "ES", "Spain"),
    ("+36", "HU", "Hungary"), ("+39", "IT", "Italy"), ("+40", "RO", "Romania"),
    ("+41", "CH", "Switzerland"), ("+43", "AT", "Austria"), ("+44", "GB", "United Kingdom"),
    ("+45", "DK", "Denmark"), ("+46", "SE", "Sweden"), ("+47", "NO", "Norway"),
    ("+48", "PL", "Poland"), ("+49", "DE", "Germany"), ("+51", "PE", "Peru"),
    ("+52", "MX", "Mexico"), ("+54", "AR", "Argentina"), ("+55", "BR", "Brazil"),
    ("+56", "CL", "Chile"), ("+57", "CO", "Colombia"), ("+58", "VE", "Venezuela"),
    ("+60", "MY", "Malaysia"), ("+61", "AU", "Australia"), ("+62", "ID", "Indonesia"),
    ("+63", "PH", "Philippines"), ("+64", "NZ", "New Zealand"), ("+65", "SG", "Singapore"),
    ("+66", "TH", "Thailand"), ("+81", "JP", "Japan"), ("+82", "KR", "South Korea"),
    ("+84", "VN", "Vietnam"), ("+86", "CN", "China"), ("+90", "TR", "Turkey"),
    ("+91", "IN", "India"), ("+92", "PK", "Pakistan"), ("+93", "AF", "Afghanistan"),
    ("+94", "LK", "Sri Lanka"), ("+95", "MM", "Myanmar"), ("+98", "IR", "Iran"),
    ("+211", "SS", "South Sudan"), ("+212", "MA", "Morocco"), ("+213", "DZ", "Algeria"),
    ("+216", "TN", "Tunisia"), ("+218", "LY", "Libya"), ("+220", "GM", "Gambia"),
    ("+221", "SN", "Senegal"), ("+233", "GH", "Ghana"), ("+234", "NG", "Nigeria"),
    ("+237", "CM", "Cameroon"), ("+250", "RW", "Rwanda"), ("+251", "ET", "Ethiopia"),
    ("+254", "KE", "Kenya"), ("+255", "TZ", "Tanzania"), ("+256", "UG", "Uganda"),
    ("+260", "ZM", "Zambia"), ("+263", "ZW", "Zimbabwe"), ("+351", "PT", "Portugal"),
    ("+352", "LU", "Luxembourg"), ("+353", "IE", "Ireland"), ("+354", "IS", "Iceland"),
    ("+356", "MT", "Malta"), ("+357", "CY", "Cyprus"), ("+358", "FI", "Finland"),
    ("+359", "BG", "Bulgaria"), ("+370", "LT", "Lithuania"), ("+371", "LV", "Latvia"),
    ("+372", "EE", "Estonia"), ("+380", "UA", "Ukraine"), ("+381", "RS", "Serbia"),
    ("+385", "HR", "Croatia"), ("+386", "SI", "Slovenia"), ("+420", "CZ", "Czech Republic"),
    ("+421", "SK", "Slovakia"), ("+852", "HK", "Hong Kong"), ("+853", "MO", "Macau"),
    ("+855", "KH", "Cambodia"), ("+880", "BD", "Bangladesh"), ("+886", "TW", "Taiwan"),
    ("+960", "MV", "Maldives"), ("+961", "LB", "Lebanon"), ("+962", "JO", "Jordan"),
    ("+963", "SY", "Syria"), ("+964", "IQ", "Iraq"), ("+965", "KW", "Kuwait"),
    ("+966", "SA", "Saudi Arabia"), ("+967", "YE", "Yemen"), ("+968", "OM", "Oman"),
    ("+971", "AE", "United Arab Emirates"), ("+972", "IL", "Israel"), ("+973", "BH", "Bahrain"),
    ("+974", "QA", "Qatar"), ("+975", "BT", "Bhutan"), ("+977", "NP", "Nepal"),
    ("+994", "AZ", "Azerbaijan"), ("+995", "GE", "Georgia"), ("+998", "UZ", "Uzbekistan"),
]
_DIAL_CODES_LONGEST_FIRST = sorted(COUNTRY_DIAL_CODES, key=lambda c: len(c[0]), reverse=True)


def _country_for_user(u: dict) -> tuple[Optional[str], str]:
    """(ISO code, display name) of the user's own phone country, from the stored
    country code (falling back to the full number)."""
    for raw in (u.get("country_code"), u.get("phone_full")):
        s = str(raw or "").strip()
        if not s:
            continue
        if not s.startswith("+"):
            s = "+" + s
        for dial, iso, name in _DIAL_CODES_LONGEST_FIRST:
            if s.startswith(dial):
                return iso, name
    return None, "Unknown country"


# WhatsApp: Meta's per-message utility-template rate (USD) by market, plus Twilio's
# per-message fee. Meta revises these on the 1st of a quarter; update this table
# from the rate card (developers.facebook.com/docs/whatsapp/pricing) when it does.
# The buffer absorbs small rate changes so we never charge below cost.
WA_RATE_BUFFER = 1.25
TWILIO_WA_FEE_USD = 0.005
WA_MARKET_RATE_USD = {
    "north_america": 0.0040, "AR": 0.0260, "BR": 0.0080, "CL": 0.0200, "CO": 0.0020,
    "EG": 0.0052, "FR": 0.0300, "DE": 0.0550, "IN": 0.0014, "ID": 0.0250, "IL": 0.0053,
    "IT": 0.0300, "MY": 0.0140, "MX": 0.0100, "NL": 0.0500, "NG": 0.0067, "PK": 0.0054,
    "PE": 0.0200, "RU": 0.0400, "SA": 0.0115, "ZA": 0.0076, "ES": 0.0200, "TR": 0.0053,
    "AE": 0.0157, "GB": 0.0220,
    "rest_africa": 0.0040, "rest_apac": 0.0160, "rest_cee": 0.0212, "rest_latam": 0.0113,
    "rest_me": 0.0091, "rest_we": 0.0300, "other": 0.0077,
}
_WA_REGIONS = {
    "north_america": "US CA",
    "rest_africa": "DZ AO BJ BW BF BI CM TD CG ER ET GA GM GH GW CI KE LS LR LY MG MW ML MR "
                   "MZ NA NE RW SN SL SO SS SD SZ TZ TG TN UG ZM ZW",
    "rest_apac": "AF AU KH CN JP LA MN NZ PG PH TW TJ TH TM UZ VN",
    "rest_cee": "AL AM AZ BY BG HR CZ GE GR LV LT MD MK RS SK SI",
    "rest_we": "AT BE DK FI IE NO PT SE CH",
    "rest_latam": "BO CR DO EC SV GT HT HN JM NI PA PY PR UY VE",
    "rest_me": "BH JO LB YE",
}
_WA_MARKET_BY_ISO = {iso: market for market, isos in _WA_REGIONS.items() for iso in isos.split()}


def _whatsapp_usd_rate(iso: Optional[str]) -> float:
    if not iso:
        return INTL_DEFAULT_CREDITS["whatsapp"] * CREDIT_USD
    market = iso if iso in WA_MARKET_RATE_USD else _WA_MARKET_BY_ISO.get(iso, "other")
    return WA_MARKET_RATE_USD[market] * WA_RATE_BUFFER + TWILIO_WA_FEE_USD


# SMS: live per-country price from Twilio's Pricing API (highest carrier price, so we
# never undercharge), cached for a week. The table below is only a fallback for when
# Twilio isn't reachable. US/Canada carrier fees are billed on top of Twilio's price.
SMS_RATE_TTL = timedelta(days=7)
SMS_CARRIER_FEE_USD = {"US": 0.005}
SMS_FALLBACK_USD = {
    "US": 0.0110, "GB": 0.0520, "AU": 0.0550, "AE": 0.0700, "SG": 0.0500, "DE": 0.0950,
    "FR": 0.0850, "JP": 0.0800, "CN": 0.0500, "SA": 0.0600, "QA": 0.0550, "KW": 0.0700,
    "OM": 0.0700, "BH": 0.0400, "NP": 0.1300, "BD": 0.3000, "PK": 0.3000, "LK": 0.2000,
    "MY": 0.0700, "ID": 0.4000, "PH": 0.2000, "TH": 0.0400, "NZ": 0.1200, "ZA": 0.0400,
    "NG": 0.3500, "KE": 0.2000, "IT": 0.0900, "ES": 0.0900, "NL": 0.1200, "IE": 0.0900,
    "BR": 0.0500, "MX": 0.0400, "HK": 0.0700,
}
_sms_rate_cache: dict[str, tuple[float, datetime]] = {}


async def _fetch_twilio_sms_price(iso: str) -> Optional[float]:
    if not _twilio_ready():
        return None
    try:
        from twilio.rest import Client  # type: ignore

        def _get() -> Optional[float]:
            country = Client(TWILIO_SID, TWILIO_TOKEN).pricing.v1.messaging.countries(iso).fetch()
            prices: list[float] = []
            for carrier in country.outbound_sms_prices or []:
                for p in carrier.get("prices", []) or []:
                    if p.get("number_type") == "shortcode":
                        continue
                    try:
                        prices.append(float(p.get("current_price") or p.get("base_price")))
                    except (TypeError, ValueError):
                        pass
            return max(prices) if prices else None

        return await asyncio.wait_for(asyncio.to_thread(_get), timeout=8)
    except Exception as e:
        logger.warning("[rates] twilio pricing lookup failed for %s: %s", iso, e)
        return None


async def _sms_usd_rate(iso: Optional[str]) -> float:
    if not iso:
        return INTL_DEFAULT_CREDITS["sms"] * CREDIT_USD
    now = datetime.now(timezone.utc)
    hit = _sms_rate_cache.get(iso)
    if hit and now - hit[1] < SMS_RATE_TTL:
        return hit[0]
    key = f"sms:{iso}"
    doc = await db.channel_rates.find_one({"key": key}, {"_id": 0})
    if doc and now - _parse_iso(doc["fetched_at"]) < SMS_RATE_TTL:
        _sms_rate_cache[iso] = (doc["usd"], _parse_iso(doc["fetched_at"]))
        return doc["usd"]
    live = await _fetch_twilio_sms_price(iso)
    if live is None:
        # A stale stored price beats the static table; retry the live lookup in an hour.
        usd = doc["usd"] if doc else SMS_FALLBACK_USD.get(iso, INTL_DEFAULT_CREDITS["sms"] * CREDIT_USD)
        _sms_rate_cache[iso] = (usd, now - SMS_RATE_TTL + timedelta(hours=1))
        return usd
    usd = live + SMS_CARRIER_FEE_USD.get(iso, 0.0)
    await db.channel_rates.update_one(
        {"key": key},
        {"$set": {"key": key, "usd": usd, "source": "twilio", "fetched_at": now.isoformat()}},
        upsert=True,
    )
    _sms_rate_cache[iso] = (usd, now)
    return usd


def _usd_to_credits(usd: float) -> int:
    return max(1, math.ceil(round(usd / CREDIT_USD, 6)))


async def _channel_quote(u: dict, channel: str) -> dict:
    """What one message on `channel` costs this user, plus how it's categorised
    in the transaction history."""
    if channel == "email":
        return {"tenths": EMAIL_TENTHS, "category": None, "country_iso": None, "country_name": None}
    iso, name = _country_for_user(u)
    if iso == DOMESTIC_ISO:
        credits = DOMESTIC_CREDITS[channel]
        category = "domestic"
    else:
        usd = await _sms_usd_rate(iso) if channel == "sms" else _whatsapp_usd_rate(iso)
        credits = _usd_to_credits(usd)
        category = "international"
    return {"tenths": credits * 10, "category": category, "country_iso": iso, "country_name": name}


async def _rates_for_user(u: dict) -> dict:
    iso, name = _country_for_user(u)
    sms = await _channel_quote(u, "sms")
    wa = await _channel_quote(u, "whatsapp")
    return {
        "country_iso": iso,
        "country_name": name,
        "category": "domestic" if iso == DOMESTIC_ISO else "international",
        "push": 0,
        "whatsapp": _tenths_to_credits(wa["tenths"]),
        "sms": _tenths_to_credits(sms["tenths"]),
        "email": _tenths_to_credits(EMAIL_TENTHS),
    }


# ---------------- Credit ledger ----------------
async def _broadcast_billing(user_id: str) -> None:
    try:
        u = await db.users.find_one({"id": user_id}, {"_id": 0, "credits_tenths": 1, "plan": 1})
        if u:
            await broadcast_to_user(user_id, {
                "type": "billing.updated",
                "data": {"plan": _effective_plan(u), "credits": _tenths_to_credits(_credits_tenths(u))},
            })
    except Exception as e:
        logger.debug("[ws] broadcast billing.updated failed: %s", e)


async def _grant_credits(
    user_id: str,
    tenths: int,
    *,
    kind: str,
    key: str,
    pack_id: Optional[str] = None,
    note: Optional[str] = None,
    provider: Optional[str] = None,
) -> bool:
    """Add credits exactly once per idempotency key. Returns False if this key was
    already applied (a webhook retry, or the app and the webhook both reporting
    the same purchase)."""
    now = datetime.now(timezone.utc).isoformat()
    entry_id = str(uuid.uuid4())
    try:
        await db.credit_ledger.insert_one({
            "id": entry_id,
            "user_id": user_id,
            "kind": kind,  # purchase | gift | admin | refund
            "delta_tenths": tenths,
            "balance_after_tenths": None,
            "pack_id": pack_id,
            "provider": provider,
            "note": note,
            "idempotency_key": key,
            "created_at": now,
        })
    except DuplicateKeyError:
        return False
    sets: dict = {"credits_exhausted_notified": False}
    if pack_id in PACKS and tenths > 0:
        sets.update({"plan": pack_id, "plan_updated_at": now})
    u = await db.users.find_one_and_update(
        {"id": user_id},
        {"$inc": {"credits_tenths": tenths}, "$set": sets},
        projection={"_id": 0, "credits_tenths": 1},
        return_document=ReturnDocument.AFTER,
    )
    if not u:
        await db.credit_ledger.delete_one({"id": entry_id})
        logger.warning("[credits] grant for missing user %s (key=%s)", user_id, key)
        return False
    await db.credit_ledger.update_one(
        {"id": entry_id}, {"$set": {"balance_after_tenths": _credits_tenths(u)}}
    )
    await _broadcast_billing(user_id)
    return True


async def _send_paid(
    user: dict,
    reminder: dict,
    occurrence: int,
    channel: str,
    role: str,
    send,
) -> str:
    """Deliver one paid message and charge for it.

    Credits are reserved atomically before the send (so two reminders firing at
    once can't overdraw), refunded if the provider rejects the message, and only
    recorded once Twilio/Resend has accepted it. The idempotency key ties the
    charge to this reminder occurrence, so a re-run of the same occurrence (e.g.
    after a restart mid-fire) neither re-sends nor re-charges.

    Returns "sent", "no_credits", "failed" or "duplicate".
    """
    key = f"use:{reminder['id']}:{occurrence}:{channel}:{role}"
    if await db.credit_ledger.find_one({"idempotency_key": key}, {"_id": 1}):
        return "duplicate"
    quote = await _channel_quote(user, channel)
    cost = quote["tenths"]
    reserved = await db.users.find_one_and_update(
        {"id": user["id"], "credits_tenths": {"$gte": cost}},
        {"$inc": {"credits_tenths": -cost}},
        projection={"_id": 0, "credits_tenths": 1},
        return_document=ReturnDocument.AFTER,
    )
    if not reserved:
        return "no_credits"
    try:
        ok = await send()
    except Exception as e:
        logger.warning("[credits] %s send raised: %s", channel, e)
        ok = False
    if not ok:
        await db.users.update_one({"id": user["id"]}, {"$inc": {"credits_tenths": cost}})
        return "failed"
    try:
        await db.credit_ledger.insert_one({
            "id": str(uuid.uuid4()),
            "user_id": user["id"],
            "kind": "usage",
            "delta_tenths": -cost,
            "balance_after_tenths": _credits_tenths(reserved),
            "channel": channel,
            "role": role,  # self | creator (copy of a reminder for someone else)
            "category": quote["category"],
            "country_iso": quote["country_iso"],
            "country_name": quote["country_name"],
            "reminder_id": reminder["id"],
            "reminder_title": reminder.get("title"),
            "target_name": None if role == "self" else (reminder.get("target") or {}).get("name"),
            "idempotency_key": key,
            "created_at": datetime.now(timezone.utc).isoformat(),
        })
    except DuplicateKeyError:
        await db.users.update_one({"id": user["id"]}, {"$inc": {"credits_tenths": cost}})
        return "duplicate"
    return "sent"


def _branded_email_html(heading: Optional[str], body_html: str, cta_label: Optional[str] = None,
                        cta_url: Optional[str] = None, footer_html: str = "") -> str:
    """The Rymind email shell used for system and admin emails."""
    title = (
        f'<h1 style="font-size:22px;color:#1B1F1A;margin:18px 0 12px;letter-spacing:-0.4px;line-height:1.3">'
        f'{html_lib.escape(heading)}</h1>'
        if heading else '<div style="height:18px"></div>'
    )
    cta = ""
    if cta_label and cta_url:
        cta = (
            f'<a href="{html_lib.escape(cta_url, quote=True)}" style="display:inline-block;background:#2A4B41;'
            f'color:#fff;text-decoration:none;font-weight:600;font-size:15px;padding:12px 22px;'
            f'border-radius:999px;margin-top:8px">{html_lib.escape(cta_label)}</a>'
        )
    return f"""
    <div style="font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif;max-width:560px;margin:0 auto;background:#F8F9F7;padding:32px 16px">
      <div style="background:#fff;border-radius:16px;padding:32px;border:1px solid #E5E7E0">
        <div style="font-size:15px;font-weight:800;color:#2A4B41;letter-spacing:-0.2px">Rymind</div>
        {title}
        <div style="color:#4A5147;font-size:15px;line-height:1.6">{body_html}</div>
        {cta}
      </div>
      <div style="color:#94978F;font-size:11px;margin-top:18px;text-align:center;line-height:1.6">{footer_html}</div>
    </div>
    """.strip()


async def _notify_credits_exhausted(user_id: str) -> None:
    """Tell the user once per run-out that paid channels are paused. The flag resets
    on the next top-up, so they hear about it again only after recharging and
    running out again."""
    u = await db.users.find_one_and_update(
        {"id": user_id, "credits_exhausted_notified": {"$ne": True}},
        {"$set": {"credits_exhausted_notified": True,
                  "credits_exhausted_at": datetime.now(timezone.utc).isoformat()}},
        projection={"_id": 0, "expo_push_token": 1, "email": 1, "full_name": 1},
    )
    if not u:
        return
    if u.get("expo_push_token"):
        await send_expo_push(
            u["expo_push_token"],
            "Your Rymind credits have run out",
            "WhatsApp, SMS and email reminders are paused. Recharge to turn them back on. App notifications keep working.",
            {"type": "credits_exhausted"},
        )
    if u.get("email"):
        first = html_lib.escape((u.get("full_name") or "there").split(" ")[0])
        body = (
            f"<p style=\"margin:0 0 14px\">Hi {first},</p>"
            "<p style=\"margin:0 0 14px\">You've used all your Rymind credits, so reminders on "
            "WhatsApp, SMS and email are paused for now. App notifications keep working as usual.</p>"
            "<p style=\"margin:0 0 18px\">Buy a credit pack in the Rymind app or on the web and your "
            "reminders go back to every channel you picked. Credits never expire.</p>"
        )
        await send_email(
            u["email"],
            "Your Rymind credits have run out",
            _branded_email_html("Your credits have run out", body, "Buy credits", f"{WEB_APP_URL}/web/plans",
                                "You're receiving this because you have a Rymind account."),
        )
    await _broadcast_billing(user_id)


async def _enforce_plan_limits(user: dict, channels: List[str], *, new_reminder: bool,
                               existing_channels: Optional[List[str]] = None) -> None:
    """Free plan = app notifications only and at most FREE_ACTIVE_LIMIT active reminders.
    Edits to an existing reminder only block channels that weren't already on it."""
    if _effective_plan(user) != "free":
        return
    already = set(existing_channels or [])
    if any(c in PAID_CHANNELS and c not in already for c in channels):
        raise HTTPException(
            402,
            "WhatsApp, SMS and email need credits. Buy a credit pack to use them, or pick App Notification.",
        )
    if new_reminder:
        active = await db.reminders.count_documents(
            {"user_id": user["id"], "status": {"$in": ["pending", "active"]}}
        )
        if active >= FREE_ACTIVE_LIMIT:
            raise HTTPException(
                402,
                f"The Free plan includes up to {FREE_ACTIVE_LIMIT} active reminders. Complete or delete "
                "one, or buy a credit pack for unlimited reminders.",
            )


# ---------------- Scheduling core ----------------
def _parse_iso(s: str) -> datetime:
    # Accept ISO with or without tz; default to UTC
    try:
        dt = datetime.fromisoformat(s.replace("Z", "+00:00"))
    except ValueError:
        dt = datetime.fromisoformat(s)
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc)


def _compute_next_fire(r: dict) -> Optional[datetime]:
    """Compute the next UTC fire time considering lead_minutes, repeat_count, repeat_interval, triggered_count."""
    base = _parse_iso(r["scheduled_at"])
    lead = timedelta(minutes=r.get("lead_minutes", 0))
    first = base - lead
    triggered = r.get("triggered_count", 0)
    repeat_count = r.get("repeat_count", 1)
    if repeat_count != -1 and triggered >= repeat_count:
        return None
    try:
        interval = timedelta(hours=float(r.get("repeat_interval_hours", 24)))
        return first + interval * triggered
    except (OverflowError, ValueError) as e:
        # Interval too large to represent (legacy bad data) — stop scheduling instead of crashing
        logger.warning("[schedule] invalid interval for reminder %s: %s", r.get("id"), e)
        return None


def _job_id(reminder_id: str) -> str:
    return f"reminder:{reminder_id}"


async def _schedule_reminder_job(reminder: dict, force_run_at: Optional[datetime] = None) -> None:
    rid = reminder["id"]
    try:
        scheduler.remove_job(_job_id(rid))
    except Exception:
        pass
    if reminder.get("status") not in (None, "pending", "active"):
        return
    # force_run_at overrides the repeat math — used by postpone/snooze so an
    # already-fired reminder fires again instead of being marked completed.
    nxt = force_run_at or _compute_next_fire(reminder)
    if not nxt:
        await db.reminders.update_one({"id": rid}, {"$set": {"status": "completed", "next_fire_at": None}})
        return
    # if in past, run after 2 seconds
    if nxt <= datetime.now(timezone.utc):
        run_at = datetime.now(timezone.utc) + timedelta(seconds=2)
    else:
        run_at = nxt
    scheduler.add_job(
        _fire_reminder,
        trigger=DateTrigger(run_date=run_at),
        args=[rid],
        id=_job_id(rid),
        replace_existing=True,
        misfire_grace_time=3600,
    )
    await db.reminders.update_one({"id": rid}, {"$set": {"next_fire_at": nxt.isoformat()}})


async def _fire_reminder(reminder_id: str) -> None:
    r = await db.reminders.find_one({"id": reminder_id}, {"_id": 0})
    if not r or r.get("status") not in ("pending", "active"):
        return
    user = await db.users.find_one({"id": r["user_id"]}, {"_id": 0})
    if not user:
        return
    title = r["title"]
    msg = r.get("message") or title
    target = r.get("target", {})
    is_self = target.get("is_self", True)
    channels = r.get("channels", [])
    results = {}
    pending_for_others = []  # channels awaiting manual user-send

    # ---------- Push delivery ----------
    if "push" in channels:
        if is_self:
            # Self reminder → notify the owner only
            if user.get("expo_push_token"):
                results["push"] = await send_expo_push(
                    user["expo_push_token"], title, msg, {"reminder_id": reminder_id}
                )
        else:
            # Reminder for another person — try to match them by phone (last 10 digits)
            target_suffix = _phone_suffix(target.get("phone"))
            other_user = None
            other_count = 0
            if target_suffix:
                # Use find with a small limit to handle the rare "multiple users with same number" case safely
                cursor = db.users.find(
                    {"phone_suffix": target_suffix, "id": {"$ne": user["id"]}},
                    {"_id": 0},
                ).limit(5)
                async for u in cursor:
                    other_count += 1
                    if other_user is None:
                        other_user = u  # use the first match for primary delivery

            if other_user and other_user.get("expo_push_token"):
                # Match found → deliver the actual reminder to the OTHER user's device
                results["push_other"] = await send_expo_push(
                    other_user["expo_push_token"],
                    title,
                    msg,
                    {"reminder_id": reminder_id, "from_user_id": user["id"]},
                )
                # Owner gets the reminder too, plus a "tap to send the rest" hint
                if user.get("expo_push_token"):
                    owner_body = (
                        f"(For {target.get('name') or 'them'}) {msg}\n"
                        f"Delivered to {target.get('name') or 'them'}. "
                        f"Tap Send for WhatsApp/SMS/Email if selected."
                    )
                    await send_expo_push(
                        user["expo_push_token"],
                        f"⏰ {title}",
                        owner_body,
                        {"reminder_id": reminder_id},
                    )
                results["push_other_match_count"] = other_count
            else:
                # No matching user → fall back to delivering to OWNER so they know to open & send
                if user.get("expo_push_token"):
                    body = msg if not target.get("name") else f"For {target['name']}: {msg}"
                    results["push"] = await send_expo_push(
                        user["expo_push_token"], title, body, {"reminder_id": reminder_id}
                    )

    # ---------- WhatsApp / SMS / Email ----------
    # - self: auto-send via server
    # - other: add to pending_channels; user will tap Send inside the reminder
    tz_name = r.get("timezone") or "UTC"
    try:
        local_tz = pytz.timezone(tz_name)
    except Exception:
        local_tz = pytz.UTC
    fired_local = datetime.now(timezone.utc).astimezone(local_tz)
    when_str = fired_local.strftime("%a, %d %b %Y · %I:%M %p")

    def _email_html(body_msg: str, footer_note: str) -> str:
        return f"""
    <div style=\"font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif;max-width:560px;margin:0 auto;background:#F8F9F7;padding:32px 16px\">
      <div style=\"background:#fff;border-radius:16px;padding:32px;border:1px solid #E5E7E0\">
        <div style=\"background:#2A4B41;color:#fff;display:inline-block;padding:6px 12px;border-radius:999px;font-size:11px;font-weight:700;letter-spacing:1.2px\">REMINDER</div>
        <h1 style=\"font-size:24px;color:#1B1F1A;margin:16px 0 8px;letter-spacing:-0.5px\">{title}</h1>
        <p style=\"color:#4A5147;font-size:15px;line-height:1.55;white-space:pre-wrap;margin:0 0 24px\">{body_msg}</p>
        <div style=\"background:#EAF2EE;border-radius:10px;padding:14px 16px;color:#2A4B41;font-size:13px;font-weight:600\">⏰ Triggered: {when_str}</div>
        <p style=\"color:#94978F;font-size:11px;margin-top:24px;text-align:center\">Sent automatically by Rymind · {footer_note}</p>
      </div>
    </div>
    """.strip()

    # SMS stays plain GSM-7 (no emoji, no middle dot) so a reminder bills as one segment.
    sms_when = fired_local.strftime("%a, %d %b %Y, %I:%M %p")
    wa_body = f"*⏰ {title}*\n{msg}\n\n_Triggered: {when_str}_"
    sms_body = f"{title}: {msg} ({sms_when})"
    email_html = _email_html(msg, "You created this reminder for yourself.")

    # Every server-sent WhatsApp/SMS/email is paid for from the creator's credits.
    # Manual sends to "someone else" go from the creator's own phone and cost nothing.
    occurrence = r.get("triggered_count", 0)
    skipped_no_credits: list[str] = []
    charged_any = False

    async def _paid(ch: str, role: str, send) -> bool:
        nonlocal charged_any
        outcome = await _send_paid(user, r, occurrence, ch, role, send)
        if outcome == "no_credits":
            skipped_no_credits.append(ch)
        elif outcome == "sent":
            charged_any = True
        return outcome in ("sent", "duplicate")

    for ch in ("whatsapp", "sms", "email"):
        if ch not in channels:
            continue
        if is_self:
            try:
                if ch == "whatsapp" and user.get("phone_full"):
                    # Pass template variables; send_whatsapp will use Content SID if configured
                    results[ch] = await _paid(ch, "self", lambda: send_whatsapp(
                        user["phone_full"],
                        wa_body,
                        template_vars={"1": title, "2": msg, "3": when_str},
                    ))
                elif ch == "sms" and user.get("phone_full"):
                    results[ch] = await _paid(ch, "self", lambda: send_sms(user["phone_full"], sms_body))
                elif ch == "email" and user.get("email"):
                    results[ch] = await _paid(ch, "self", lambda: send_email(user["email"], f"⏰ {title}", email_html))
                else:
                    results[ch] = False
                    logger.warning("[fire] self %s skipped: missing user contact for %s", ch, user.get("id"))
            except Exception as e:
                # Never let a 3rd-party failure crash the engine
                results[ch] = False
                logger.warning("[fire] self %s exception: %s", ch, e)
        else:
            # Target delivery stays manual (pending_channels, user taps Send),
            # but the creator also receives a copy on their own channels right away.
            pending_for_others.append(ch)
            t_name = target.get("name") or "them"
            creator_msg = f"(For {t_name}) {msg}"
            try:
                if ch == "whatsapp" and user.get("phone_full"):
                    results[f"{ch}_creator"] = await _paid(ch, "creator", lambda: send_whatsapp(
                        user["phone_full"],
                        f"*⏰ {title}*\n{creator_msg}\n\n_Triggered: {when_str}_",
                        template_vars={"1": title, "2": creator_msg, "3": when_str},
                    ))
                elif ch == "sms" and user.get("phone_full"):
                    results[f"{ch}_creator"] = await _paid(ch, "creator", lambda: send_sms(
                        user["phone_full"], f"{title}: {creator_msg} ({sms_when})"
                    ))
                elif ch == "email" and user.get("email"):
                    results[f"{ch}_creator"] = await _paid(ch, "creator", lambda: send_email(
                        user["email"],
                        f"⏰ {title}",
                        _email_html(creator_msg, f"You created this reminder for {t_name}."),
                    ))
                else:
                    results[f"{ch}_creator"] = False
                    logger.warning("[fire] creator copy %s skipped: missing contact for %s", ch, user.get("id"))
            except Exception as e:
                results[f"{ch}_creator"] = False
                logger.warning("[fire] creator copy %s exception: %s", ch, e)

    if skipped_no_credits:
        results["skipped_no_credits"] = skipped_no_credits
    try:
        if skipped_no_credits:
            await _notify_credits_exhausted(user["id"])
        elif charged_any:
            fresh_user = await db.users.find_one({"id": user["id"]}, {"_id": 0, "credits_tenths": 1})
            if fresh_user and _credits_tenths(fresh_user) <= 0:
                await _notify_credits_exhausted(user["id"])
            else:
                await _broadcast_billing(user["id"])
    except Exception as e:
        logger.warning("[fire] credit notice failed for %s: %s", user.get("id"), e)

    now = datetime.now(timezone.utc).isoformat()
    new_triggered = r.get("triggered_count", 0) + 1
    update = {
        "triggered_count": new_triggered,
        "last_fired_at": now,
        "last_results": results,
    }
    if pending_for_others:
        existing = set(r.get("pending_channels", []) or [])
        existing.update(pending_for_others)
        update["pending_channels"] = sorted(existing)

    log_entry = {
        "id": str(uuid.uuid4()),
        "reminder_id": reminder_id,
        "fired_at": now,
        "results": results,
    }
    await db.reminder_logs.insert_one(log_entry)

    # Complete when repeats are exhausted AND nothing is awaiting manual send.
    # - self: no pending channels, so completes once repeats run out.
    # - other with WhatsApp/SMS/Email: stays pending until the user taps Send
    #   (mark-sent completes it); the repeat cap still applies via that path.
    # - other push-only: no pending channels, so it completes instead of lingering.
    repeat_count = r.get("repeat_count", 1)
    repeats_done = repeat_count != -1 and new_triggered >= repeat_count
    if repeats_done and not update.get("pending_channels"):
        update["status"] = "completed"
        update["next_fire_at"] = None

    await db.reminders.update_one({"id": reminder_id}, {"$set": update})

    # Reschedule next occurrence for any reminder (self OR other) with repeats left.
    # An "other" reminder re-fires identically each time: push auto-delivers and
    # WhatsApp/SMS/Email re-enter pending_channels for the creator to send manually.
    updated = await db.reminders.find_one({"id": reminder_id}, {"_id": 0})
    if (
        updated
        and updated.get("status") in ("pending", "active")
        and (r.get("repeat_count", 1) == -1 or new_triggered < r.get("repeat_count", 1))
    ):
        await _schedule_reminder_job(updated)

    # Broadcast fired event to all signed-in clients for this user
    try:
        if updated:
            await broadcast_to_user(
                r["user_id"],
                {"type": "reminder.fired", "data": _reminder_to_out(updated).model_dump()},
            )
    except Exception as e:
        logger.debug("[ws] broadcast reminder.fired failed: %s", e)


async def _migrate_existing_users_to_credits() -> None:
    """One-time switch to plans: every account that predates billing starts on Free
    and receives the smallest pack once as a welcome gift. New signups get
    credits_tenths=0 at creation, so they never match this query. The ledger key
    makes the gift impossible to grant twice, even across restarts."""
    legacy_ids = [
        u["id"] async for u in db.users.find({"credits_tenths": {"$exists": False}}, {"_id": 0, "id": 1})
    ]
    if not legacy_ids:
        return
    await db.users.update_many(
        {"id": {"$in": legacy_ids}, "credits_tenths": {"$exists": False}},
        {"$set": {"credits_tenths": 0, "plan": "free", "credits_exhausted_notified": False}},
    )
    gift = PACKS[WELCOME_GIFT_PACK]
    granted = 0
    for uid in legacy_ids:
        if await _grant_credits(
            uid,
            gift["credits"] * 10,
            kind="gift",
            key=f"gift:welcome:{uid}",
            pack_id=WELCOME_GIFT_PACK,
            note="Welcome gift",
        ):
            await db.users.update_one(
                {"id": uid}, {"$set": {"welcome_gift_at": datetime.now(timezone.utc).isoformat()}}
            )
            granted += 1
    logger.info("[credits] migrated %d existing users, welcome gift granted to %d", len(legacy_ids), granted)


# ---------------- Lifespan ----------------
@asynccontextmanager
async def lifespan(app: FastAPI):
    await db.users.create_index("email", unique=True)
    await db.users.create_index("phone_full")
    await db.users.create_index("phone_suffix")
    await db.reminders.create_index("user_id")
    await db.contacts.create_index("user_id")
    # Verification codes auto-expire after 10 minutes
    await db.verification_codes.create_index("created_at", expireAfterSeconds=600)
    # Failed logins are only counted inside the lockout window
    await db.login_failures.create_index("at", expireAfterSeconds=LOGIN_WINDOW_MINUTES * 60)
    await db.login_failures.create_index([("email", 1), ("at", -1)])
    await db.login_failures.create_index([("ip", 1), ("at", -1)])
    # Migration: backfill phone_suffix on existing users
    async for u in db.users.find({"phone_suffix": {"$exists": False}}, {"_id": 0, "id": 1, "phone_full": 1, "phone": 1}):
        suffix = _phone_suffix(u.get("phone_full") or u.get("phone"))
        if suffix:
            await db.users.update_one({"id": u["id"]}, {"$set": {"phone_suffix": suffix}})
    # Billing collections
    await db.credit_ledger.create_index("idempotency_key", unique=True)
    await db.credit_ledger.create_index([("user_id", 1), ("created_at", -1)])
    await db.payments.create_index([("provider", 1), ("provider_ref", 1)], unique=True)
    await db.channel_rates.create_index("key", unique=True)
    await db.email_campaigns.create_index("created_at")
    # A restart kills any in-flight broadcast; mark it so it doesn't block new sends.
    await db.email_campaigns.update_many({"status": "sending"}, {"$set": {"status": "interrupted"}})
    await _migrate_existing_users_to_credits()
    scheduler.start()
    # reschedule all active reminders
    async for r in db.reminders.find({"status": {"$in": ["pending", "active"]}}, {"_id": 0}):
        await _schedule_reminder_job(r)
    logger.info("Rymind started. Scheduler running.")
    yield
    scheduler.shutdown(wait=False)
    client.close()


app = FastAPI(title="Rymind API", lifespan=lifespan)

# ---------------- CORS ----------------
_cors_origins = [
    o.strip() for o in os.environ.get("CORS_ORIGINS", "").split(",") if o.strip()
]
app.add_middleware(
    CORSMiddleware,
    allow_origins=_cors_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

api = APIRouter(prefix="/api")


# ---------------- Helpers ----------------
def _user_to_out(u: dict) -> UserOut:
    return UserOut(
        id=u["id"],
        email=u["email"],
        phone=u["phone"],
        full_name=u["full_name"],
        country_code=u.get("country_code", "+91"),
        expo_push_token=u.get("expo_push_token"),
        created_at=u.get("created_at", ""),
        # Legacy users (created under the old verify-at-signup flow) default to verified.
        phone_verified=u.get("phone_verified", True),
        email_verified=u.get("email_verified", True),
        marketing_consent=u.get("marketing_consent", False),
        plan=_effective_plan(u),
        credits=_tenths_to_credits(_credits_tenths(u)),
    )


def _reminder_to_out(r: dict) -> ReminderOut:
    pending = r.get("pending_channels", []) or []
    return ReminderOut(
        id=r["id"],
        user_id=r["user_id"],
        title=r["title"],
        message=r.get("message", ""),
        scheduled_at=r["scheduled_at"],
        timezone=r.get("timezone", "UTC"),
        channels=r.get("channels", []),
        repeat_count=r.get("repeat_count", 1),
        repeat_interval_hours=r.get("repeat_interval_hours", 24),
        lead_minutes=r.get("lead_minutes", 0),
        target=ReminderTarget(**r.get("target", {"is_self": True})),
        status=r.get("status", "pending"),
        triggered_count=r.get("triggered_count", 0),
        created_at=r.get("created_at", ""),
        next_fire_at=r.get("next_fire_at"),
        last_fired_at=r.get("last_fired_at"),
        pending_channels=pending,
        needs_user_send=len(pending) > 0,
        contact_id=r.get("contact_id"),
    )


# ---------------- Routes ----------------
@api.get("/")
async def root():
    return {"app": "Rymind", "status": "ok"}


@api.get("/health")
async def health():
    return {
        "ok": True,
        "scheduler_running": scheduler.running,
        "integrations": {
            "twilio": _twilio_ready(),
            "resend": bool(RESEND_KEY),
        },
    }


# ------- Auth — Verification -------
def _generate_verify_code() -> str:
    return str(random.randint(100000, 999999))


def _create_verify_token(target: str, value: str) -> str:
    """Short-lived JWT proving the user verified their phone/email."""
    payload = {
        f"{target}_verified": value,
        "exp": datetime.now(timezone.utc) + timedelta(minutes=15),
        "iat": datetime.now(timezone.utc),
        "purpose": "signup_verify",
    }
    return jwt.encode(payload, JWT_SECRET, algorithm=JWT_ALG)


def _decode_verify_token(token: str, target: str, expected_value: str) -> bool:
    """Validate a verification JWT matches the expected target+value."""
    try:
        payload = jwt.decode(token, JWT_SECRET, algorithms=[JWT_ALG])
        if payload.get("purpose") != "signup_verify":
            return False
        return payload.get(f"{target}_verified") == expected_value
    except jwt.PyJWTError:
        return False


def _verification_email_html(code: str) -> str:
    return f"""
    <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;max-width:560px;margin:0 auto;background:#F8F9F7;padding:32px 16px">
      <div style="background:#fff;border-radius:16px;padding:32px;border:1px solid #E5E7E0">
        <div style="text-align:center;margin-bottom:24px">
          <div style="background:#2A4B41;color:#fff;display:inline-block;padding:8px 16px;border-radius:999px;font-size:12px;font-weight:700;letter-spacing:1.5px">RYMIND</div>
        </div>
        <h1 style="font-size:22px;color:#1B1F1A;margin:0 0 8px;text-align:center;letter-spacing:-0.5px">Verify your email</h1>
        <p style="color:#4A5147;font-size:15px;line-height:1.55;text-align:center;margin:0 0 24px">Enter this code in the Rymind app to verify your email address.</p>
        <div style="background:#F0F5F2;border-radius:12px;padding:20px;text-align:center;margin:0 0 24px">
          <span style="font-size:36px;font-weight:800;letter-spacing:8px;color:#2A4B41">{code}</span>
        </div>
        <p style="color:#6B756E;font-size:13px;text-align:center;margin:0 0 8px">This code expires in <strong>10 minutes</strong>.</p>
        <p style="color:#94978F;font-size:11px;margin-top:24px;text-align:center">If you didn't request this code, you can safely ignore this email.</p>
      </div>
      <p style="color:#94978F;font-size:11px;margin-top:16px;text-align:center">&copy; Rymind &middot; rymind.in</p>
    </div>
    """.strip()


def _reset_password_email_html(token: str) -> str:
    # Must be an https link — custom app schemes (remindly://) are not clickable in
    # email clients. Points to the web app's reset page, which calls /auth/reset-password.
    link = f"{WEB_APP_URL}/reset-password?token={token}"
    return f"""
    <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;max-width:560px;margin:0 auto;background:#F8F9F7;padding:32px 16px">
      <div style="background:#fff;border-radius:16px;padding:32px;border:1px solid #E5E7E0">
        <div style="text-align:center;margin-bottom:24px">
          <div style="background:#2A4B41;color:#fff;display:inline-block;padding:8px 16px;border-radius:999px;font-size:12px;font-weight:700;letter-spacing:1.5px">RYMIND</div>
        </div>
        <h1 style="font-size:22px;color:#1B1F1A;margin:0 0 8px;text-align:center;letter-spacing:-0.5px">Reset your password</h1>
        <p style="color:#4A5147;font-size:15px;line-height:1.55;text-align:center;margin:0 0 24px">Click the button below to set a new password for your Rymind account.</p>
        <div style="text-align:center;margin:0 0 24px">
          <a href="{link}" style="display:inline-block;background:#2A4B41;color:#fff;text-decoration:none;padding:14px 28px;border-radius:8px;font-weight:600;font-size:15px">Reset Password</a>
        </div>
        <p style="color:#6B756E;font-size:13px;text-align:center;margin:0 0 8px">This link expires in <strong>1 hour</strong>.</p>
        <p style="color:#94978F;font-size:11px;margin-top:24px;text-align:center">If you didn't request a password reset, you can safely ignore this email.</p>
      </div>
      <p style="color:#94978F;font-size:11px;margin-top:16px;text-align:center">&copy; Rymind &middot; rymind.in</p>
    </div>
    """.strip()


@api.post("/auth/send-code")
async def send_verification_code(payload: SendCodeIn):
    target = payload.target
    value = payload.value.strip()
    if not value:
        raise HTTPException(400, "Value is required")

    # Rate limit: max 5 codes per target+value per hour
    one_hour_ago = datetime.now(timezone.utc) - timedelta(hours=1)
    recent_count = await db.verification_codes.count_documents({
        "target": target,
        "value": value,
        "created_at": {"$gte": one_hour_ago},
    })
    if recent_count >= 5:
        raise HTTPException(429, "Too many code requests. Please wait and try again.")

    code = _generate_verify_code()
    ins = await db.verification_codes.insert_one({
        "target": target,
        "value": value,
        "code": code,
        "created_at": datetime.now(timezone.utc),
    })

    if target == "phone":
        phone_full = value if value.startswith("+") else f"{payload.country_code}{re.sub(r'[^0-9]', '', value)}"
        sms_body = f"Your Rymind verification code is: {code}. Valid for 10 minutes."
        sent = await send_sms(phone_full, sms_body)
    else:
        sent = await send_email(value.lower(), "Your Rymind verification code", _verification_email_html(code))

    if not sent:
        # Don't claim success when nothing went out — the user would wait for a code
        # that never arrives. Drop the unsent code so it doesn't eat the hourly limit.
        await db.verification_codes.delete_one({"_id": ins.inserted_id})
        logger.warning("[verify] %s code could not be sent to %s", target, value)
        what = "SMS" if target == "phone" else "email"
        raise HTTPException(503, f"We couldn't send the verification {what} right now. Please try again in a few minutes.")

    return {"ok": True, "message": "Verification code sent"}


async def _check_verification_code(target: str, value: str, code: str) -> tuple[bool, str]:
    """Validate a one-time code for target+value. Consumes it on success; throttles
    guessing. Returns (ok, error_message)."""
    doc = await db.verification_codes.find_one(
        {"target": target, "value": value}, sort=[("created_at", -1)]
    )
    if not doc:
        return False, "Invalid or expired code"
    if doc.get("attempts", 0) >= 5:
        await db.verification_codes.delete_many({"target": target, "value": value})
        return False, "Too many incorrect attempts. Request a new code."
    if doc.get("code") != code:
        await db.verification_codes.update_one({"_id": doc["_id"]}, {"$inc": {"attempts": 1}})
        return False, "Invalid or expired code"
    await db.verification_codes.delete_many({"target": target, "value": value})
    return True, ""


@api.post("/auth/verify-code")
async def verify_code(payload: VerifyCodeIn):
    ok, msg = await _check_verification_code(payload.target, payload.value.strip(), payload.code.strip())
    if not ok:
        return {"ok": False, "verified": False, "message": msg}
    token = _create_verify_token(payload.target, payload.value.strip())
    return {"ok": True, "verified": True, "token": token}


class ResetPasswordRequestIn(BaseModel):
    email: str

@api.post("/auth/reset-password-request")
async def reset_password_request(payload: ResetPasswordRequestIn):
    email = payload.email.lower().strip()
    u = await db.users.find_one({"email": email})
    if not u:
        return {"ok": True, "message": "If the email is registered, a reset link will be sent."}
        
    # Rate limit: max 3 per hour
    one_hour_ago = datetime.now(timezone.utc) - timedelta(hours=1)
    recent_count = await db.password_resets.count_documents({
        "email": email,
        "created_at": {"$gte": one_hour_ago},
    })
    if recent_count >= 3:
        raise HTTPException(429, "Too many requests. Please wait before trying again.")

    token = str(uuid.uuid4())
    await db.password_resets.insert_one({
        "email": email,
        "token": token,
        "created_at": datetime.now(timezone.utc),
    })
    
    html = _reset_password_email_html(token)
    sent = await send_email(email, "Reset your Rymind password", html)
    if not sent:
        logger.info("[reset-password] Email mock for %s: token %s", email, token)
    
    return {"ok": True, "message": "If the email is registered, a reset link will be sent."}


class ResetPasswordIn(BaseModel):
    token: str
    new_password: str = Field(..., min_length=6)

@api.post("/auth/reset-password")
async def reset_password(payload: ResetPasswordIn):
    doc = await db.password_resets.find_one({"token": payload.token})
    if not doc:
        raise HTTPException(400, "Invalid or expired reset link")
    
    # Check expiry (1 hour)
    one_hour_ago = datetime.now(timezone.utc) - timedelta(hours=1)
    # Ensure doc["created_at"] is comparable. It's stored as datetime in MongoDB motor.
    created_at = doc.get("created_at")
    if getattr(created_at, "tzinfo", None) is None:
        created_at = created_at.replace(tzinfo=timezone.utc)
        
    if created_at < one_hour_ago:
        await db.password_resets.delete_one({"_id": doc["_id"]})
        raise HTTPException(400, "Reset link has expired")
        
    hashed = await asyncio.to_thread(hash_password, payload.new_password)
    await db.users.update_one({"email": doc["email"]}, {"$set": {"password_hash": hashed}})
    await db.password_resets.delete_many({"email": doc["email"]})
    # A fresh password lifts any login lockout on this account.
    await db.login_failures.delete_many({"email": doc["email"]})

    return {"ok": True, "message": "Password updated successfully"}


# ------- Auth — Signup & Login -------
@api.post("/auth/signup", response_model=TokenOut)
async def signup(payload: UserSignup):
    email = payload.email.lower().strip()
    phone_raw = re.sub(r"[^\d]", "", payload.phone)
    if not phone_raw:
        raise HTTPException(400, "Invalid phone number")
    phone_full = f"{payload.country_code}{phone_raw}"
    phone_suffix = _phone_suffix(phone_full)

    # No verification at signup — but reject duplicates by email OR phone.
    dup = await db.users.find_one({"$or": [{"email": email}, {"phone_suffix": phone_suffix}]})
    if dup:
        raise HTTPException(
            400,
            "An account with this email address or phone number already exists. "
            "Please use a different email address or phone number.",
        )
    user_id = str(uuid.uuid4())
    now = datetime.now(timezone.utc).isoformat()
    doc = {
        "id": user_id,
        "email": email,
        "phone": phone_raw,
        "phone_full": phone_full,
        "phone_suffix": phone_suffix,
        "country_code": payload.country_code,
        "full_name": payload.full_name.strip(),
        "password_hash": await asyncio.to_thread(hash_password, payload.password),
        "expo_push_token": None,
        "created_at": now,
        "last_login_at": now,
        # Verified later, in-app, after the grace period.
        "phone_verified": False,
        "email_verified": False,
        # Opt-in for marketing emails; managed via /marketing/unsubscribe.
        "marketing_consent": bool(payload.marketing_consent),
        "marketing_consent_at": now if payload.marketing_consent else None,
        "marketing_unsubscribed_at": None,
        # New accounts start on the Free plan with no credits.
        "plan": "free",
        "credits_tenths": 0,
        "credits_exhausted_notified": False,
    }
    await db.users.insert_one(doc)
    token = create_access_token(user_id)
    return TokenOut(access_token=token, user=_user_to_out(doc))


@api.post("/marketing/unsubscribe")
async def marketing_unsubscribe(payload: MarketingUnsubscribeIn):
    """Opt an email out of marketing communications.

    Called by the web unsubscribe pages (both the one-click link from an email,
    /unsubscribe?email=…, and the manual "enter your email" form at /unsubscribe).
    No auth: the email address is the identifier. Always responds success so the
    endpoint can't be used to enumerate which emails have accounts. Only flips a
    marketing flag — no destructive effect — so a plain email key is acceptable.
    """
    email = payload.email.lower().strip()
    now = datetime.now(timezone.utc).isoformat()
    await db.users.update_one(
        {"email": email},
        {"$set": {"marketing_consent": False, "marketing_unsubscribed_at": now}},
    )
    return {
        "success": True,
        "email": email,
        "message": "You have been unsubscribed from marketing emails.",
    }


# Brute-force guard for /auth/login, which both the app and Rymind Web call.
LOGIN_WINDOW_MINUTES = 15
LOGIN_MAX_FAILS_PER_EMAIL = 5
LOGIN_MAX_FAILS_PER_IP = 30


def _client_ip(request: Request) -> str:
    # Railway sits behind a proxy; the first X-Forwarded-For hop is the client.
    fwd = request.headers.get("x-forwarded-for", "")
    if fwd:
        return fwd.split(",")[0].strip()
    return request.client.host if request.client else ""


async def _check_login_lock(email: str, ip: str):
    since = datetime.now(timezone.utc) - timedelta(minutes=LOGIN_WINDOW_MINUTES)
    by_email = await db.login_failures.count_documents({"email": email, "at": {"$gte": since}})
    by_ip = await db.login_failures.count_documents({"ip": ip, "at": {"$gte": since}}) if ip else 0
    if by_email >= LOGIN_MAX_FAILS_PER_EMAIL or by_ip >= LOGIN_MAX_FAILS_PER_IP:
        raise HTTPException(
            429, f"Too many failed attempts. Please wait {LOGIN_WINDOW_MINUTES} minutes or reset your password."
        )


async def _record_login_failure(email: str, ip: str):
    await db.login_failures.insert_one({"email": email, "ip": ip, "at": datetime.now(timezone.utc)})


async def _authenticate_password(email: str, password: str, request: Request) -> dict:
    """Shared email+password check for the app (/auth/login) and Rymind Web."""
    email = email.lower().strip()
    ip = _client_ip(request)
    await _check_login_lock(email, ip)
    u = await db.users.find_one({"email": email})
    if not u:
        await _record_login_failure(email, ip)
        raise HTTPException(404, "No account found with this email. Please create an account to continue.")
    if not await asyncio.to_thread(verify_password, password, u["password_hash"]):
        await _record_login_failure(email, ip)
        raise HTTPException(401, "Incorrect password. Please try again.")
    await db.login_failures.delete_many({"email": email})
    return u


@api.post("/auth/login", response_model=TokenOut)
async def login(payload: UserLogin, request: Request):
    u = await _authenticate_password(payload.email, payload.password, request)

    now = datetime.now(timezone.utc).isoformat()
    await db.users.update_one({"id": u["id"]}, {"$set": {"last_login_at": now}})
    
    token = create_access_token(u["id"])
    return TokenOut(access_token=token, user=_user_to_out(u))


@api.get("/auth/me", response_model=UserOut)
async def me(current=Depends(get_current_user)):
    return _user_to_out(current)


@api.post("/auth/verify-phone", response_model=UserOut)
async def verify_phone(payload: VerifyPhoneIn, current=Depends(get_current_user)):
    """Verify (and optionally update) the signed-in user's phone via OTP."""
    digits = re.sub(r"[^0-9]", "", payload.phone)
    if not digits:
        raise HTTPException(400, "Please enter a valid phone number.")
    phone_full = f"{payload.country_code}{digits}"
    ok, msg = await _check_verification_code("phone", phone_full, payload.code.strip())
    if not ok:
        raise HTTPException(400, msg)
    suffix = _phone_suffix(phone_full)
    other = await db.users.find_one({"phone_suffix": suffix, "id": {"$ne": current["id"]}})
    if other:
        raise HTTPException(400, "This phone number is already linked to another account.")
    await db.users.update_one({"id": current["id"]}, {"$set": {
        "phone": digits,
        "phone_full": phone_full,
        "phone_suffix": suffix,
        "country_code": payload.country_code,
        "phone_verified": True,
    }})
    u = await db.users.find_one({"id": current["id"]}, {"_id": 0})
    return _user_to_out(u)


@api.post("/auth/verify-email", response_model=UserOut)
async def verify_email(payload: VerifyEmailIn, current=Depends(get_current_user)):
    """Verify (and optionally update) the signed-in user's email via OTP."""
    email = payload.email.lower().strip()
    ok, msg = await _check_verification_code("email", email, payload.code.strip())
    if not ok:
        raise HTTPException(400, msg)
    other = await db.users.find_one({"email": email, "id": {"$ne": current["id"]}})
    if other:
        raise HTTPException(400, "This email is already linked to another account.")
    await db.users.update_one({"id": current["id"]}, {"$set": {"email": email, "email_verified": True}})
    u = await db.users.find_one({"id": current["id"]}, {"_id": 0})
    return _user_to_out(u)


@api.patch("/auth/profile", response_model=UserOut)
async def update_profile(payload: ProfileUpdateIn, current=Depends(get_current_user)):
    """Direct profile edits. A phone/email that is already verified can't be changed
    here — it must go through OTP (verify-phone / verify-email)."""
    updates: dict = {}
    if payload.full_name is not None and payload.full_name.strip():
        updates["full_name"] = payload.full_name.strip()

    if payload.phone is not None:
        if current.get("phone_verified", True):
            raise HTTPException(400, "Please verify the new phone number to change it.")
        digits = re.sub(r"[^0-9]", "", payload.phone)
        if len(digits) < 6:
            raise HTTPException(400, "Please enter a valid phone number.")
        cc = payload.country_code or current.get("country_code", "+91")
        phone_full = f"{cc}{digits}"
        suffix = _phone_suffix(phone_full)
        other = await db.users.find_one({"phone_suffix": suffix, "id": {"$ne": current["id"]}})
        if other:
            raise HTTPException(400, "This phone number is already linked to another account.")
        updates.update({"phone": digits, "phone_full": phone_full, "phone_suffix": suffix, "country_code": cc})

    if payload.email is not None:
        if current.get("email_verified", True):
            raise HTTPException(400, "Please verify the new email to change it.")
        email = payload.email.lower().strip()
        other = await db.users.find_one({"email": email, "id": {"$ne": current["id"]}})
        if other:
            raise HTTPException(400, "This email is already linked to another account.")
        updates["email"] = email

    if updates:
        await db.users.update_one({"id": current["id"]}, {"$set": updates})
    u = await db.users.find_one({"id": current["id"]}, {"_id": 0})
    return _user_to_out(u)


@api.post("/auth/push-token")
async def set_push_token(body: PushTokenIn, current=Depends(get_current_user)):
    await db.users.update_one({"id": current["id"]}, {"$set": {"expo_push_token": body.token}})
    return {"ok": True}


@api.delete("/auth/account")
async def delete_account(current=Depends(get_current_user)):
    """Permanently delete the authenticated user's account and ALL associated data."""
    uid = current["id"]
    logger.info("[account] deleting user %s (%s)", uid, current.get("email"))

    # 1. Fetch every reminder (any status) — ids for log cleanup, active ones for job cancel
    user_reminders = await db.reminders.find(
        {"user_id": uid}, {"_id": 0, "id": 1, "status": 1}
    ).to_list(5000)
    all_reminder_ids = [r["id"] for r in user_reminders]
    for r in user_reminders:
        if r.get("status") in ("pending", "active"):
            try:
                scheduler.remove_job(_job_id(r["id"]))
            except Exception:
                pass

    # 2. Delete all data from every collection
    del_reminders = await db.reminders.delete_many({"user_id": uid})
    del_contacts = await db.contacts.delete_many({"user_id": uid})
    del_logs = await db.reminder_logs.delete_many(
        {"reminder_id": {"$in": all_reminder_ids}}
    )
    del_sessions = await db.web_sessions.delete_many({"user_id": uid})
    del_codes = await db.verification_codes.delete_many(
        {"$or": [{"value": current.get("email", "")}, {"value": current.get("phone_full", "")}]}
    )
    # Credit history goes with the account. Payment records are kept (no personal
    # details, just the user id) because purchases must stay on file for accounting.
    await db.credit_ledger.delete_many({"user_id": uid})

    # 3. Delete the user record itself
    await db.users.delete_one({"id": uid})

    # 4. Disconnect any active WebSocket connections for this user
    sockets = list(_user_sockets.pop(uid, set()))
    for ws in sockets:
        try:
            await ws.send_json({"type": "account_deleted"})
            await ws.close(code=4410)
        except Exception:
            pass

    logger.info(
        "[account] deleted user=%s reminders=%d contacts=%d logs=%d sessions=%d codes=%d",
        uid,
        del_reminders.deleted_count,
        del_contacts.deleted_count,
        del_logs.deleted_count,
        del_sessions.deleted_count,
        del_codes.deleted_count,
    )

    return {
        "ok": True,
        "message": "Account and all associated data permanently deleted",
        "deleted": {
            "reminders": del_reminders.deleted_count,
            "contacts": del_contacts.deleted_count,
            "logs": del_logs.deleted_count,
            "web_sessions": del_sessions.deleted_count,
        },
    }


# ------- Reminders -------
@api.post("/reminders", response_model=ReminderOut)
async def create_reminder(payload: ReminderCreate, current=Depends(get_current_user)):
    # validate scheduled_at parses
    try:
        _parse_iso(payload.scheduled_at)
    except Exception:
        raise HTTPException(400, "Please pick a valid date and time.")
    await _enforce_plan_limits(current, list(payload.channels), new_reminder=True)
    rid = str(uuid.uuid4())
    now = datetime.now(timezone.utc).isoformat()
    doc = {
        "id": rid,
        "user_id": current["id"],
        "title": payload.title.strip(),
        "message": (payload.message or "").strip(),
        "scheduled_at": payload.scheduled_at,
        "timezone": payload.timezone,
        "channels": list(dict.fromkeys(payload.channels)),
        "repeat_count": payload.repeat_count,
        "repeat_interval_hours": payload.repeat_interval_hours,
        "lead_minutes": payload.lead_minutes,
        "target": payload.target.model_dump(),
        "contact_id": payload.contact_id,
        "status": "pending",
        "triggered_count": 0,
        "created_at": now,
        "next_fire_at": None,
        "last_fired_at": None,
    }
    await db.reminders.insert_one(doc)
    await _schedule_reminder_job(doc)
    doc_fresh = await db.reminders.find_one({"id": rid}, {"_id": 0})
    out = _reminder_to_out(doc_fresh)
    try:
        await broadcast_to_user(current["id"], {"type": "reminder.created", "data": out.model_dump()})
    except Exception as e:
        logger.debug("[ws] broadcast reminder.created failed: %s", e)
    return out


async def _resolve_unlinked_contacts(uid: str, reminders: list[dict]) -> None:
    unlinked = [r for r in reminders if not r.get("contact_id") and (r.get("target") or {}).get("phone")]
    if not unlinked:
        return
    contacts = await db.contacts.find({"user_id": uid}, {"_id": 0, "id": 1, "phone": 1}).to_list(500)
    suffix_to_cid = {}
    for c in contacts:
        s = _phone_suffix(c.get("phone"))
        if s and s not in suffix_to_cid:
            suffix_to_cid[s] = c["id"]
    if not suffix_to_cid:
        return
    for r in unlinked:
        s = _phone_suffix(r["target"]["phone"])
        if s and s in suffix_to_cid:
            cid = suffix_to_cid[s]
            r["contact_id"] = cid
            asyncio.create_task(db.reminders.update_one({"id": r["id"]}, {"$set": {"contact_id": cid}}))


@api.get("/reminders", response_model=List[ReminderOut])
async def list_active_reminders(current=Depends(get_current_user)):
    items = await db.reminders.find(
        {"user_id": current["id"], "status": {"$in": ["pending", "active"]}},
        {"_id": 0},
    ).sort("scheduled_at", 1).to_list(500)
    await _resolve_unlinked_contacts(current["id"], items)
    return [_reminder_to_out(x) for x in items]


@api.get("/reminders/history", response_model=List[ReminderOut])
async def list_history(current=Depends(get_current_user)):
    items = await db.reminders.find(
        {"user_id": current["id"], "status": {"$in": ["completed", "cancelled"]}},
        {"_id": 0},
    ).sort("created_at", -1).to_list(500)
    await _resolve_unlinked_contacts(current["id"], items)
    # Mark reminders whose linked contact has since been deleted (so the client can
    # hide reschedule/resend — there's no contact to act on anymore).
    contact_ids = set(await db.contacts.distinct("id", {"user_id": current["id"]}))
    out = []
    for x in items:
        ro = _reminder_to_out(x)
        if x.get("contact_id") and x["contact_id"] not in contact_ids:
            ro.contact_missing = True
        out.append(ro)
    return out


@api.delete("/reminders/history")
async def clear_history(current=Depends(get_current_user)):
    """Delete all finished (completed/cancelled) reminders for the user."""
    res = await db.reminders.delete_many(
        {"user_id": current["id"], "status": {"$in": ["completed", "cancelled"]}}
    )
    try:
        await broadcast_to_user(current["id"], {"type": "history.cleared", "data": {}})
    except Exception as e:
        logger.debug("[ws] broadcast history.cleared failed: %s", e)
    return {"ok": True, "deleted": res.deleted_count}


@api.get("/reminders/{rid}", response_model=ReminderOut)
async def get_reminder(rid: str, current=Depends(get_current_user)):
    r = await db.reminders.find_one({"id": rid, "user_id": current["id"]}, {"_id": 0})
    if not r:
        raise HTTPException(404, "Reminder not found")
    await _resolve_unlinked_contacts(current["id"], [r])
    return _reminder_to_out(r)


@api.post("/reminders/{rid}/mark-sent", response_model=ReminderOut)
async def mark_channel_sent(rid: str, body: MarkSentIn, current=Depends(get_current_user)):
    """User tapped Send for a WhatsApp/SMS/Email channel for a reminder-for-others.
    Removes the channel from pending_channels. When empty, move reminder to completed."""
    r = await db.reminders.find_one({"id": rid, "user_id": current["id"]}, {"_id": 0})
    if not r:
        raise HTTPException(404, "Reminder not found")
    pending = list(r.get("pending_channels", []) or [])
    if body.channel in pending:
        pending.remove(body.channel)
    update: dict = {"pending_channels": pending}
    if not pending:
        # Only finish the reminder when there are no future repeats left. A repeating
        # reminder stays pending so its next occurrence can re-queue the channels.
        repeat_count = r.get("repeat_count", 1)
        triggered = r.get("triggered_count", 0)
        more_occurrences = repeat_count == -1 or triggered < repeat_count
        if not more_occurrences:
            update["status"] = "completed"
            update["next_fire_at"] = None
            try:
                scheduler.remove_job(_job_id(rid))
            except Exception:
                pass
    await db.reminders.update_one({"id": rid}, {"$set": update})
    fresh = await db.reminders.find_one({"id": rid}, {"_id": 0})
    out = _reminder_to_out(fresh)
    try:
        await broadcast_to_user(current["id"], {"type": "reminder.updated", "data": out.model_dump()})
    except Exception as e:
        logger.debug("[ws] broadcast reminder.updated failed: %s", e)
    return out


@api.patch("/reminders/{rid}", response_model=ReminderOut)
async def update_reminder(rid: str, body: ReminderUpdate, current=Depends(get_current_user)):
    r = await db.reminders.find_one({"id": rid, "user_id": current["id"]}, {"_id": 0})
    if not r:
        raise HTTPException(404, "Reminder not found")
    updates = {k: v for k, v in body.model_dump(exclude_unset=True).items() if v is not None}
    if "scheduled_at" in updates:
        _parse_iso(updates["scheduled_at"])  # validate
    if "channels" in updates:
        await _enforce_plan_limits(
            current, updates["channels"], new_reminder=False, existing_channels=r.get("channels", [])
        )
    if updates:
        await db.reminders.update_one({"id": rid}, {"$set": updates})
    fresh = await db.reminders.find_one({"id": rid}, {"_id": 0})
    if fresh.get("status") in ("pending", "active"):
        await _schedule_reminder_job(fresh)
    out = _reminder_to_out(fresh)
    try:
        await broadcast_to_user(current["id"], {"type": "reminder.updated", "data": out.model_dump()})
    except Exception as e:
        logger.debug("[ws] broadcast reminder.updated failed: %s", e)
    return out


@api.post("/reminders/{rid}/action", response_model=ReminderOut)
async def reminder_action(rid: str, body: StatusUpdate, current=Depends(get_current_user)):
    r = await db.reminders.find_one({"id": rid, "user_id": current["id"]}, {"_id": 0})
    if not r:
        raise HTTPException(404, "Reminder not found")
    if body.action == "complete":
        await db.reminders.update_one({"id": rid}, {"$set": {"status": "completed", "next_fire_at": None}})
        try:
            scheduler.remove_job(_job_id(rid))
        except Exception:
            pass
    elif body.action == "cancel":
        await db.reminders.update_one({"id": rid}, {"$set": {"status": "cancelled", "next_fire_at": None}})
        try:
            scheduler.remove_job(_job_id(rid))
        except Exception:
            pass
    elif body.action == "postpone":
        mins = body.postpone_minutes or 30
        # Postpone relative to the reminder's own trigger time, not the click time.
        new_time = _parse_iso(r["scheduled_at"]) + timedelta(minutes=mins)
        await db.reminders.update_one(
            {"id": rid},
            {"$set": {"scheduled_at": new_time.isoformat(), "status": "pending"}},
        )
        fresh = await db.reminders.find_one({"id": rid}, {"_id": 0})
        # Force the next fire to the snooze time regardless of triggered/repeat count
        await _schedule_reminder_job(fresh, force_run_at=new_time)
    fresh = await db.reminders.find_one({"id": rid}, {"_id": 0})
    out = _reminder_to_out(fresh)
    try:
        await broadcast_to_user(current["id"], {"type": "reminder.updated", "data": out.model_dump()})
    except Exception as e:
        logger.debug("[ws] broadcast reminder.updated failed: %s", e)
    return out


@api.delete("/reminders/{rid}")
async def delete_reminder(rid: str, current=Depends(get_current_user)):
    res = await db.reminders.delete_one({"id": rid, "user_id": current["id"]})
    if res.deleted_count == 0:
        raise HTTPException(404, "Reminder not found")
    try:
        scheduler.remove_job(_job_id(rid))
    except Exception:
        pass
    try:
        await broadcast_to_user(current["id"], {"type": "reminder.deleted", "data": {"id": rid}})
    except Exception as e:
        logger.debug("[ws] broadcast reminder.deleted failed: %s", e)
    return {"ok": True}


# ------- Contacts -------
async def _active_reminder_ids_for_contact(uid: str, contact: dict) -> List[str]:
    """Active reminder ids belonging to a contact — linked by contact_id, OR unlinked
    (no contact_id) but matching the contact's phone by last-10-digit suffix. The suffix
    branch catches the first reminder created in the same flow that saved the contact,
    before the contact id existed."""
    cid = contact["id"]
    csuffix = _phone_suffix(contact.get("phone"))
    ids: List[str] = []
    async for r in db.reminders.find(
        {"user_id": uid, "status": {"$in": ["pending", "active"]}},
        {"_id": 0, "id": 1, "contact_id": 1, "target": 1},
    ):
        rcid = r.get("contact_id")
        if rcid == cid:
            ids.append(r["id"])
        elif not rcid and csuffix and _phone_suffix((r.get("target") or {}).get("phone")) == csuffix:
            ids.append(r["id"])
    return ids


@api.post("/contacts", response_model=ContactOut)
async def create_contact(payload: ContactCreate, current=Depends(get_current_user)):
    cid = str(uuid.uuid4())
    now = datetime.now(timezone.utc).isoformat()
    doc = {
        "id": cid,
        "user_id": current["id"],
        "name": payload.name.strip(),
        "phone": payload.phone,
        "email": payload.email,
        "created_at": now,
    }
    await db.contacts.insert_one(doc)
    out = ContactOut(**{k: v for k, v in doc.items() if k != "_id"})
    try:
        await broadcast_to_user(current["id"], {"type": "contact.created", "data": out.model_dump()})
    except Exception as e:
        logger.debug("[ws] broadcast contact.created failed: %s", e)
    return out


@api.put("/contacts/{cid}", response_model=ContactOut)
async def update_contact(cid: str, payload: ContactUpdate, current=Depends(get_current_user)):
    existing = await db.contacts.find_one({"id": cid, "user_id": current["id"]}, {"_id": 0})
    if not existing:
        raise HTTPException(404, "Contact not found")
    updates = {
        "name": payload.name.strip(),
        "phone": payload.phone.strip(),
        "email": (payload.email or "").strip() or None,
    }
    await db.contacts.update_one({"id": cid, "user_id": current["id"]}, {"$set": updates})

    # Contact is the single source of truth: push the new details into every
    # reminder linked to this contact so active/pending and resend flows stay current.
    await db.reminders.update_many(
        {"user_id": current["id"], "contact_id": cid},
        {"$set": {
            "target.name": updates["name"],
            "target.phone": updates["phone"],
            "target.email": updates["email"],
        }},
    )

    out = ContactOut(**{**existing, **updates})
    try:
        await broadcast_to_user(current["id"], {"type": "contact.updated", "data": out.model_dump()})
        async for r in db.reminders.find({"user_id": current["id"], "contact_id": cid}, {"_id": 0}):
            await broadcast_to_user(current["id"], {"type": "reminder.updated", "data": _reminder_to_out(r).model_dump()})
    except Exception as e:
        logger.debug("[ws] broadcast contact.updated failed: %s", e)
    return out


@api.get("/contacts", response_model=List[ContactOut])
async def list_contacts(current=Depends(get_current_user)):
    items = await db.contacts.find({"user_id": current["id"]}, {"_id": 0}).sort("name", 1).to_list(500)
    # Count active reminders per contact: linked by contact_id, or unlinked but matching
    # the contact's phone suffix (catches the first reminder saved alongside the contact).
    valid_ids = {c["id"] for c in items}
    suffix_to_cid: dict[str, str] = {}
    for c in items:
        s = _phone_suffix(c.get("phone"))
        if s and s not in suffix_to_cid:
            suffix_to_cid[s] = c["id"]
    counts: dict[str, int] = {}
    async for r in db.reminders.find(
        {"user_id": current["id"], "status": {"$in": ["pending", "active"]}},
        {"_id": 0, "contact_id": 1, "target": 1},
    ):
        rcid = r.get("contact_id")
        if rcid and rcid in valid_ids:
            counts[rcid] = counts.get(rcid, 0) + 1
        elif not rcid:
            s = _phone_suffix((r.get("target") or {}).get("phone"))
            mapped = suffix_to_cid.get(s) if s else None
            if mapped:
                counts[mapped] = counts.get(mapped, 0) + 1
    return [ContactOut(**c, active_reminders=counts.get(c["id"], 0)) for c in items]


@api.delete("/contacts/{cid}")
async def delete_contact(cid: str, delete_reminders: bool = False, current=Depends(get_current_user)):
    contact = await db.contacts.find_one({"id": cid, "user_id": current["id"]}, {"_id": 0})
    if not contact:
        raise HTTPException(404, "Contact not found")

    deleted_reminder_ids: List[str] = []
    if delete_reminders:
        deleted_reminder_ids = await _active_reminder_ids_for_contact(current["id"], contact)
        if deleted_reminder_ids:
            await db.reminders.delete_many({"id": {"$in": deleted_reminder_ids}, "user_id": current["id"]})
            for rid in deleted_reminder_ids:
                try:
                    scheduler.remove_job(_job_id(rid))
                except Exception:
                    pass

    await db.contacts.delete_one({"id": cid, "user_id": current["id"]})
    try:
        await broadcast_to_user(current["id"], {"type": "contact.deleted", "data": {"id": cid}})
        for rid in deleted_reminder_ids:
            await broadcast_to_user(current["id"], {"type": "reminder.deleted", "data": {"id": rid}})
    except Exception as e:
        logger.debug("[ws] broadcast contact.deleted failed: %s", e)
    return {"ok": True, "deleted_reminders": len(deleted_reminder_ids)}


# =====================================================================
# Web QR-Login (companion web app pairing) endpoints + WebSocket
# =====================================================================
import asyncio as _asyncio_qr

WEB_SESSION_TTL_MIN = 5          # QR validity until scanned
WEB_TOKEN_EXP_DAYS = 30           # JWT lifetime after approval

# In-memory map: session_id -> set of WebSocket connections waiting for approval
_qr_listeners: dict[str, set[WebSocket]] = {}


def _make_web_jwt(user_id: str, session_id: str) -> str:
    payload = {
        "sub": user_id,
        "web_session": session_id,
        "exp": datetime.now(timezone.utc) + timedelta(days=WEB_TOKEN_EXP_DAYS),
        "iat": datetime.now(timezone.utc),
    }
    return jwt.encode(payload, JWT_SECRET, algorithm=JWT_ALG)


async def _broadcast_qr(session_id: str, payload: dict) -> None:
    listeners = list(_qr_listeners.get(session_id, set()))
    for ws in listeners:
        try:
            await ws.send_json(payload)
        except Exception:
            pass


class WebSessionCreate(BaseModel):
    user_agent: Optional[str] = None
    ip: Optional[str] = None


class WebSessionApprove(BaseModel):
    device_label: Optional[str] = None


@api.post("/web-sessions")
async def create_web_session(body: WebSessionCreate):
    sid = str(uuid.uuid4())
    now = datetime.now(timezone.utc)
    doc = {
        "session_id": sid,
        "status": "pending",
        "user_id": None,
        "jwt_token": None,
        "device_info": {
            "ua": (body.user_agent or "")[:300],
            "ip": (body.ip or "")[:64],
            "label": None,
        },
        "created_at": now.isoformat(),
        "expires_at": (now + timedelta(minutes=WEB_SESSION_TTL_MIN)).isoformat(),
        "approved_at": None,
        "last_seen_at": now.isoformat(),
    }
    await db.web_sessions.insert_one(doc)
    return {"session_id": sid, "expires_at": doc["expires_at"]}


@api.get("/web-sessions/{session_id}")
async def get_web_session(session_id: str):
    """Public status poll (fallback if WebSocket fails). Token is only returned once,
    within 60 seconds of approval, and then nulled."""
    sess = await db.web_sessions.find_one({"session_id": session_id}, {"_id": 0})
    if not sess:
        raise HTTPException(404, "Session not found")
    # auto-expire if too old
    if sess["status"] == "pending" and datetime.fromisoformat(sess["expires_at"]) < datetime.now(timezone.utc):
        await db.web_sessions.update_one({"session_id": session_id}, {"$set": {"status": "expired"}})
        sess["status"] = "expired"
    if sess["status"] != "approved":
        return {"status": sess["status"]}
    # one-shot token delivery
    token = sess.get("jwt_token")
    user = None
    if token:
        u = await db.users.find_one({"id": sess["user_id"]}, {"_id": 0, "password_hash": 0})
        if u:
            user = u
        await db.web_sessions.update_one(
            {"session_id": session_id},
            {"$set": {"jwt_token": None}},  # consume the token
        )
    return {"status": "approved", "token": token, "user": user}


@api.post("/web-sessions/{session_id}/approve")
async def approve_web_session(
    session_id: str,
    body: WebSessionApprove,
    current=Depends(get_current_user),
):
    sess = await db.web_sessions.find_one({"session_id": session_id})
    if not sess:
        raise HTTPException(404, "Session not found")
    if sess["status"] != "pending":
        raise HTTPException(409, f"Session is {sess['status']}")
    if datetime.fromisoformat(sess["expires_at"]) < datetime.now(timezone.utc):
        await db.web_sessions.update_one({"session_id": session_id}, {"$set": {"status": "expired"}})
        raise HTTPException(410, "Session expired")
    token = _make_web_jwt(current["id"], session_id)
    now = datetime.now(timezone.utc)
    await db.web_sessions.update_one(
        {"session_id": session_id},
        {
            "$set": {
                "status": "approved",
                "user_id": current["id"],
                "jwt_token": token,
                "approved_at": now.isoformat(),
                "expires_at": (now + timedelta(days=WEB_TOKEN_EXP_DAYS)).isoformat(),
                "last_seen_at": now.isoformat(),
                "device_info.label": body.device_label or sess["device_info"].get("label"),
            }
        },
    )
    user = await db.users.find_one({"id": current["id"]}, {"_id": 0, "password_hash": 0})
    # Push to any web client waiting on the websocket
    await _broadcast_qr(session_id, {"type": "approved", "token": token, "user": user})
    return {"ok": True}


class WebPasswordLogin(BaseModel):
    email: EmailStr
    password: str
    user_agent: Optional[str] = None


@api.post("/web-sessions/password-login")
async def web_password_login(body: WebPasswordLogin, request: Request):
    """Email+password sign-in for Rymind Web. Creates an already-approved web
    session so the browser shows up under Linked Devices on the phone and can be
    signed out from there, exactly like a QR sign-in."""
    u = await _authenticate_password(body.email, body.password, request)
    sid = str(uuid.uuid4())
    now = datetime.now(timezone.utc)
    await db.web_sessions.insert_one({
        "session_id": sid,
        "status": "approved",
        "user_id": u["id"],
        "jwt_token": None,  # handed back directly below, never stored
        "device_info": {
            "ua": (body.user_agent or "")[:300],
            "ip": _client_ip(request)[:64],
            "label": None,  # app derives "Chrome on Windows" etc. from ua, same as QR
        },
        "created_at": now.isoformat(),
        "expires_at": (now + timedelta(days=WEB_TOKEN_EXP_DAYS)).isoformat(),
        "approved_at": now.isoformat(),
        "last_seen_at": now.isoformat(),
    })
    await db.users.update_one({"id": u["id"]}, {"$set": {"last_login_at": now.isoformat()}})
    user = await db.users.find_one({"id": u["id"]}, {"_id": 0, "password_hash": 0})
    return {"session_id": sid, "token": _make_web_jwt(u["id"], sid), "user": user}


@api.get("/web-sessions")
async def list_web_sessions(current=Depends(get_current_user)):
    cursor = db.web_sessions.find(
        {"user_id": current["id"], "status": "approved"},
        {"_id": 0, "jwt_token": 0},
    ).sort("approved_at", -1)
    items = await cursor.to_list(50)
    return items


@api.delete("/web-sessions/{session_id}")
async def revoke_web_session(session_id: str, current=Depends(get_current_user)):
    sess = await db.web_sessions.find_one({"session_id": session_id})
    if not sess:
        raise HTTPException(404, "Session not found")
    if sess.get("user_id") and sess["user_id"] != current["id"]:
        raise HTTPException(403, "Not your session")
    await db.web_sessions.update_one(
        {"session_id": session_id},
        {"$set": {"status": "revoked", "jwt_token": None}},
    )
    await _broadcast_qr(session_id, {"type": "revoked"})
    return {"ok": True}


@app.websocket("/api/ws/web-session/{session_id}")
async def ws_web_session(websocket: WebSocket, session_id: str):
    await websocket.accept()
    sess = await db.web_sessions.find_one({"session_id": session_id})
    if not sess:
        await websocket.send_json({"type": "error", "code": "not_found"})
        await websocket.close()
        return
    # If already approved before connect, deliver instantly and close.
    if sess["status"] == "approved":
        user = await db.users.find_one({"id": sess["user_id"]}, {"_id": 0, "password_hash": 0})
        await websocket.send_json({"type": "approved", "token": sess.get("jwt_token"), "user": user})
        await websocket.close()
        return
    if sess["status"] != "pending":
        await websocket.send_json({"type": sess["status"]})
        await websocket.close()
        return
    _qr_listeners.setdefault(session_id, set()).add(websocket)
    try:
        # Keep connection open until approved/expired/disconnected
        while True:
            try:
                # short-circuit on TTL
                expires_at = datetime.fromisoformat(sess["expires_at"])
                if datetime.now(timezone.utc) > expires_at:
                    await websocket.send_json({"type": "expired"})
                    break
                await _asyncio_qr.sleep(2)
            except Exception:
                break
    except WebSocketDisconnect:
        pass
    finally:
        _qr_listeners.get(session_id, set()).discard(websocket)
        try:
            await websocket.close()
        except Exception:
            pass


# ------- Billing: plans, credits & payments -------
class RazorpayOrderIn(BaseModel):
    pack_id: Literal["starter", "popular", "business"]


class RazorpayVerifyIn(BaseModel):
    razorpay_order_id: str = Field(..., min_length=1, max_length=64)
    razorpay_payment_id: str = Field(..., min_length=1, max_length=64)
    razorpay_signature: str = Field(..., min_length=1, max_length=256)


def _format_price(amount: float, currency: str) -> str:
    if not amount:
        return "Free"
    if currency == "INR":
        return f"₹{amount:,.0f}"
    return f"${amount:,.2f}"


def _plan_catalog(u: dict) -> list[dict]:
    currency = _billing_currency(u)
    out = []
    for p in PLANS:
        price = p["price_inr"] if currency == "INR" else p["price_usd"]
        out.append({
            "id": p["id"],
            "name": p["name"],
            "credits": p["credits"],
            "tagline": p["tagline"],
            "features": p["features"],
            "recommended": p["recommended"],
            "product_id": p["product_id"],
            "price": price,
            "currency": currency,
            "display_price": _format_price(price, currency),
        })
    return out


def _billing_summary(u: dict) -> dict:
    return {"plan": _effective_plan(u), "credits": _tenths_to_credits(_credits_tenths(u))}


def _ledger_out(d: dict) -> dict:
    pack = PACKS.get(d.get("pack_id") or "")
    return {
        "id": d["id"],
        "kind": d.get("kind"),
        "credits": _tenths_to_credits(int(d.get("delta_tenths") or 0)),
        "balance_after": None if d.get("balance_after_tenths") is None
        else _tenths_to_credits(int(d["balance_after_tenths"])),
        "channel": d.get("channel"),
        "role": d.get("role"),
        "category": d.get("category"),
        "country_name": d.get("country_name"),
        "reminder_id": d.get("reminder_id"),
        "reminder_title": d.get("reminder_title"),
        "target_name": d.get("target_name"),
        "pack_id": d.get("pack_id"),
        "pack_name": pack["name"] if pack else None,
        "provider": d.get("provider"),
        "note": d.get("note"),
        "created_at": d.get("created_at"),
    }


@api.get("/billing/me")
async def billing_me(current=Depends(get_current_user)):
    """Everything the Plans screen needs: current plan, balance, catalog in the user's
    checkout currency, and what each channel costs for their country."""
    active_q = {"user_id": current["id"], "status": {"$in": ["pending", "active"]}}
    active, paid_channel_reminders = await asyncio.gather(
        db.reminders.count_documents(active_q),
        db.reminders.count_documents({**active_q, "channels": {"$in": list(PAID_CHANNELS)}}),
    )
    return {
        **_billing_summary(current),
        "last_pack": current.get("plan") if current.get("plan") in PACKS else None,
        "active_reminders": active,
        "paid_channel_reminders": paid_channel_reminders,
        "free_active_limit": FREE_ACTIVE_LIMIT,
        "currency": _billing_currency(current),
        "plans": _plan_catalog(current),
        "rates": await _rates_for_user(current),
        "welcome_gift": bool(current.get("welcome_gift_at")),
        "welcome_gift_credits": PACKS[WELCOME_GIFT_PACK]["credits"],
        "web_checkout": bool(RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET),
    }


@api.get("/billing/history")
async def billing_history(limit: int = 50, before: Optional[str] = None, current=Depends(get_current_user)):
    """Credit transactions, newest first. Page with ?before=<created_at of the last item>."""
    limit = max(1, min(limit, 100))
    q: dict = {"user_id": current["id"]}
    if before:
        q["created_at"] = {"$lt": before}
    docs = await db.credit_ledger.find(q, {"_id": 0, "idempotency_key": 0}).sort(
        "created_at", -1
    ).limit(limit).to_list(limit)
    return {
        "items": [_ledger_out(d) for d in docs],
        "next_before": docs[-1]["created_at"] if len(docs) == limit else None,
    }


async def _credit_purchase(
    user_id: str,
    pack_id: str,
    *,
    provider: str,
    ref: str,
    amount: Optional[float] = None,
    currency: Optional[str] = None,
    store: Optional[str] = None,
    environment: Optional[str] = None,
) -> bool:
    """Credit a paid pack once per provider transaction and record the payment."""
    pack = PACKS[pack_id]
    granted = await _grant_credits(
        user_id,
        pack["credits"] * 10,
        kind="purchase",
        key=f"pay:{provider}:{ref}",
        pack_id=pack_id,
        provider=provider,
        note=f"{pack['name']} pack",
    )
    now = datetime.now(timezone.utc).isoformat()
    sets = {"user_id": user_id, "pack_id": pack_id, "credits": pack["credits"], "status": "paid"}
    for k, v in (("amount", amount), ("currency", currency), ("store", store), ("environment", environment)):
        if v is not None:
            sets[k] = v
    if granted:
        sets["paid_at"] = now
    await db.payments.update_one(
        {"provider": provider, "provider_ref": ref},
        {"$set": sets, "$setOnInsert": {"id": str(uuid.uuid4()), "created_at": now}},
        upsert=True,
    )
    return granted


async def _refund_purchase(provider: str, ref: str) -> None:
    """Take back a refunded pack's credits (never below zero) and mark the payment."""
    pay = await db.payments.find_one({"provider": provider, "provider_ref": ref}, {"_id": 0})
    if not pay or pay.get("status") != "paid":
        return
    pack = PACKS.get(pay.get("pack_id") or "")
    u = await db.users.find_one({"id": pay["user_id"]}, {"_id": 0, "credits_tenths": 1})
    if pack and u:
        take = min(_credits_tenths(u), pack["credits"] * 10)
        if take > 0:
            await _grant_credits(
                pay["user_id"], -take, kind="refund", key=f"refund:{provider}:{ref}",
                provider=provider, note=f"{pack['name']} pack refunded",
            )
    await db.payments.update_one(
        {"provider": provider, "provider_ref": ref},
        {"$set": {"status": "refunded", "refunded_at": datetime.now(timezone.utc).isoformat()}},
    )


# --- Mobile: App Store / Google Play via RevenueCat ---
async def _resolve_revenuecat_user(ev: dict) -> Optional[str]:
    """The app logs in to RevenueCat with our user id, so app_user_id (or one of its
    aliases, for a purchase made before login finished) is a Rymind user id."""
    candidates = [ev.get("app_user_id"), ev.get("original_app_user_id"), *(ev.get("aliases") or [])]
    for c in candidates:
        if c and not str(c).startswith("$RCAnonymousID"):
            u = await db.users.find_one({"id": str(c)}, {"_id": 0, "id": 1})
            if u:
                return u["id"]
    return None


@api.post("/billing/revenuecat/webhook")
async def revenuecat_webhook(request: Request, authorization: Optional[str] = Header(None)):
    """RevenueCat calls this for every store purchase/refund. Authenticated by the
    shared secret set as the webhook's Authorization header in RevenueCat."""
    if not REVENUECAT_WEBHOOK_AUTH:
        raise HTTPException(503, "RevenueCat webhook is not configured.")
    supplied = (authorization or "").strip()
    if not (hmac.compare_digest(supplied, REVENUECAT_WEBHOOK_AUTH)
            or hmac.compare_digest(supplied, f"Bearer {REVENUECAT_WEBHOOK_AUTH}")):
        raise HTTPException(401, "Unauthorized")
    payload = await request.json()
    ev = payload.get("event") or {}
    etype = ev.get("type")
    pack_id = PRODUCT_TO_PACK.get(ev.get("product_id") or "")
    txn = ev.get("transaction_id")
    if not pack_id or not txn:
        return {"ok": True, "ignored": etype}
    if etype == "NON_RENEWING_PURCHASE":
        uid = await _resolve_revenuecat_user(ev)
        if not uid:
            logger.warning("[revenuecat] purchase %s for unknown user %s", txn, ev.get("app_user_id"))
            return {"ok": True, "ignored": "unknown_user"}
        await _credit_purchase(
            uid, pack_id, provider="revenuecat", ref=str(txn),
            amount=ev.get("price_in_purchased_currency"), currency=ev.get("currency"),
            store=ev.get("store"), environment=ev.get("environment"),
        )
    elif etype == "CANCELLATION":
        # For one-time purchases a cancellation means the store refunded it.
        await _refund_purchase("revenuecat", str(txn))
    return {"ok": True}


@api.post("/billing/revenuecat/sync")
async def revenuecat_sync(current=Depends(get_current_user)):
    """Called by the app right after a purchase so credits show up instantly instead
    of waiting for the webhook. Safe to call any time: it only credits store
    transactions that haven't been credited yet."""
    if not REVENUECAT_SECRET_KEY:
        raise HTTPException(503, "In-app purchases aren't set up on the server yet.")
    try:
        async with httpx.AsyncClient(timeout=10) as http:
            resp = await http.get(
                f"https://api.revenuecat.com/v1/subscribers/{quote(current['id'], safe='')}",
                headers={"Authorization": f"Bearer {REVENUECAT_SECRET_KEY}"},
            )
    except Exception as e:
        logger.warning("[revenuecat] sync request failed: %s", e)
        resp = None
    if resp is None or resp.status_code != 200:
        raise HTTPException(502, "Your purchase went through. Credits will appear in a minute or two.")
    non_subs = ((resp.json() or {}).get("subscriber") or {}).get("non_subscriptions") or {}
    credited = 0
    for product_id, txns in non_subs.items():
        pack_id = PRODUCT_TO_PACK.get(product_id)
        if not pack_id:
            continue
        for t in txns or []:
            ref = t.get("store_transaction_id")
            if not ref:
                continue  # the webhook keys on the store id; never credit under a different key
            if await _credit_purchase(
                current["id"], pack_id, provider="revenuecat", ref=str(ref), store=t.get("store"),
                environment="SANDBOX" if t.get("is_sandbox") else "PRODUCTION",
            ):
                credited += 1
    fresh = await db.users.find_one({"id": current["id"]}, {"_id": 0})
    return {"credited": credited, **_billing_summary(fresh or current)}


# --- Web: Razorpay checkout ---
def _razorpay_ready() -> bool:
    return bool(RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET)


async def _razorpay(method: str, path: str, body: Optional[dict] = None) -> dict:
    async with httpx.AsyncClient(timeout=15, auth=(RAZORPAY_KEY_ID, RAZORPAY_KEY_SECRET)) as http:
        resp = await http.request(method, f"https://api.razorpay.com/v1{path}", json=body)
    if resp.status_code >= 400:
        logger.warning("[razorpay] %s %s -> %s %s", method, path, resp.status_code, resp.text[:300])
        raise HTTPException(502, "The payment service didn't respond as expected. Please try again.")
    return resp.json()


async def _settle_razorpay_order(order_id: str, payment: dict) -> bool:
    """Credit an order once its payment is captured. Shared by the checkout callback
    and the webhook, so whichever arrives first credits and the other is a no-op."""
    pay_doc = await db.payments.find_one({"provider": "razorpay", "provider_ref": order_id}, {"_id": 0})
    if not pay_doc or payment.get("order_id") != order_id:
        return False
    if int(payment.get("amount") or 0) != int(pay_doc["amount_minor"]) or payment.get("currency") != pay_doc["currency"]:
        logger.warning("[razorpay] amount mismatch on order %s", order_id)
        return False
    if payment.get("status") == "authorized":
        # Accounts without auto-capture leave payments authorized; capture now.
        try:
            payment = await _razorpay("POST", f"/payments/{payment['id']}/capture",
                                      {"amount": pay_doc["amount_minor"], "currency": pay_doc["currency"]})
        except HTTPException:
            payment = await _razorpay("GET", f"/payments/{payment['id']}")
    if payment.get("status") != "captured":
        return False
    await db.payments.update_one(
        {"provider": "razorpay", "provider_ref": order_id},
        {"$set": {"provider_payment_id": payment.get("id")}},
    )
    await _credit_purchase(
        pay_doc["user_id"], pay_doc["pack_id"], provider="razorpay", ref=order_id,
        amount=pay_doc.get("amount"), currency=pay_doc.get("currency"),
    )
    return True


@api.post("/billing/razorpay/order")
async def razorpay_create_order(body: RazorpayOrderIn, current=Depends(get_current_user)):
    if not _razorpay_ready():
        raise HTTPException(503, "Web payments aren't available yet. You can buy credits in the Rymind mobile app.")
    pack = PACKS[body.pack_id]
    currency = _billing_currency(current)
    price = pack["price_inr"] if currency == "INR" else pack["price_usd"]
    amount_minor = int(round(price * 100))
    order = await _razorpay("POST", "/orders", {
        "amount": amount_minor,
        "currency": currency,
        "receipt": f"rym_{uuid.uuid4().hex[:20]}",
        "notes": {"user_id": current["id"], "pack_id": pack["id"]},
    })
    await db.payments.insert_one({
        "id": str(uuid.uuid4()),
        "provider": "razorpay",
        "provider_ref": order["id"],
        "user_id": current["id"],
        "pack_id": pack["id"],
        "credits": pack["credits"],
        "amount": price,
        "amount_minor": amount_minor,
        "currency": currency,
        "status": "created",
        "created_at": datetime.now(timezone.utc).isoformat(),
    })
    return {
        "order_id": order["id"],
        "key_id": RAZORPAY_KEY_ID,
        "amount": amount_minor,
        "currency": currency,
        "pack_id": pack["id"],
        "description": f"{pack['name']} pack, {pack['credits']:,} credits",
        "prefill": {
            "name": current.get("full_name") or "",
            "email": current.get("email") or "",
            "contact": current.get("phone_full") or "",
        },
    }


@api.post("/billing/razorpay/verify")
async def razorpay_verify(body: RazorpayVerifyIn, current=Depends(get_current_user)):
    if not _razorpay_ready():
        raise HTTPException(503, "Web payments aren't available yet.")
    expected = hmac.new(
        RAZORPAY_KEY_SECRET.encode(),
        f"{body.razorpay_order_id}|{body.razorpay_payment_id}".encode(),
        hashlib.sha256,
    ).hexdigest()
    if not hmac.compare_digest(expected, body.razorpay_signature):
        raise HTTPException(400, "We couldn't verify this payment. If money was taken, contact support and we'll fix it.")
    pay_doc = await db.payments.find_one(
        {"provider": "razorpay", "provider_ref": body.razorpay_order_id, "user_id": current["id"]}, {"_id": 0}
    )
    if not pay_doc:
        raise HTTPException(404, "Order not found.")
    payment = await _razorpay("GET", f"/payments/{body.razorpay_payment_id}")
    if not await _settle_razorpay_order(body.razorpay_order_id, payment):
        raise HTTPException(
            400, "This payment hasn't completed yet. If money was taken, your credits will be added within a few minutes."
        )
    fresh = await db.users.find_one({"id": current["id"]}, {"_id": 0})
    return _billing_summary(fresh or current)


@api.post("/billing/razorpay/webhook")
async def razorpay_webhook(request: Request, x_razorpay_signature: Optional[str] = Header(None)):
    """Backstop for web payments: credits orders even if the buyer closed the tab
    before the checkout callback ran, and claws back refunds."""
    if not RAZORPAY_WEBHOOK_SECRET:
        raise HTTPException(503, "Razorpay webhook is not configured.")
    raw = await request.body()
    expected = hmac.new(RAZORPAY_WEBHOOK_SECRET.encode(), raw, hashlib.sha256).hexdigest()
    if not x_razorpay_signature or not hmac.compare_digest(expected, x_razorpay_signature):
        raise HTTPException(400, "Invalid signature")
    data = json.loads(raw or b"{}")
    event = data.get("event")
    entities = data.get("payload") or {}
    payment = (entities.get("payment") or {}).get("entity") or {}
    if event in ("payment.captured", "order.paid") and payment.get("order_id"):
        await _settle_razorpay_order(payment["order_id"], payment)
    elif event == "payment.failed" and payment.get("order_id"):
        await db.payments.update_one(
            {"provider": "razorpay", "provider_ref": payment["order_id"], "status": "created"},
            {"$set": {"status": "failed"}},
        )
    elif event in ("refund.processed", "refund.created"):
        refund = (entities.get("refund") or {}).get("entity") or {}
        pay = await db.payments.find_one(
            {"provider": "razorpay", "provider_payment_id": refund.get("payment_id")}, {"_id": 0}
        )
        if pay:
            await _refund_purchase("razorpay", pay["provider_ref"])
    return {"ok": True}


# ------- Admin Analytics -------
@api.get("/admin/analytics")
async def get_admin_analytics():
    # These queries are independent — run them concurrently instead of sequentially
    # (was ~8 round-trips back-to-back; now a single batch).
    (
        total_users,
        total_devices,
        distribution_docs,
        recent_users,
        total_reminders,
        active_reminders,
        completed_reminders,
        total_triggers,
    ) = await asyncio.gather(
        db.users.count_documents({}),
        db.users.count_documents({"expo_push_token": {"$ne": None}}),
        db.users.aggregate([{"$group": {"_id": "$country_code", "count": {"$sum": 1}}}]).to_list(100),
        db.users.find(
            {}, {"_id": 0, "full_name": 1, "email": 1, "phone_full": 1, "country_code": 1, "last_login_at": 1, "created_at": 1}
        ).sort("last_login_at", -1).limit(50).to_list(50),
        db.reminders.count_documents({}),
        db.reminders.count_documents({"status": {"$in": ["pending", "active"]}}),
        db.reminders.count_documents({"status": "completed"}),
        db.reminder_logs.count_documents({}),
    )

    distribution = [{"region": d["_id"] or "Unknown", "count": d["count"]} for d in distribution_docs]
    for u in recent_users:
        if "last_login_at" not in u:
            u["last_login_at"] = u.get("created_at")

    return {
        "users": {
            "total": total_users,
            "active_devices_downloads": total_devices,
            "distribution": distribution,
            "recent_logins": recent_users
        },
        "reminders": {
            "total": total_reminders,
            "active": active_reminders,
            "completed": completed_reminders,
            "total_triggers": total_triggers
        }
    }


@api.get("/admin/user-activity")
async def get_admin_user_activity():
    """Every reminder created across all users (newest first) with creator name/email
    and its selected delivery channels. Temporary internal monitoring tool, behind the
    obfuscated admin URL like /admin/analytics."""
    user_docs = await db.users.find(
        {}, {"_id": 0, "id": 1, "full_name": 1, "email": 1}
    ).to_list(5000)
    users = {u["id"]: u for u in user_docs}

    reminders = await db.reminders.find({}, {"_id": 0}).sort("created_at", -1).to_list(2000)
    items = []
    for r in reminders:
        u = users.get(r.get("user_id"), {})
        out = _reminder_to_out(r).model_dump()
        out["user_name"] = u.get("full_name", "Unknown")
        out["user_email"] = u.get("email", "")
        items.append(out)
    return {"reminders": items, "total": len(items)}


def _require_admin(x_admin_key: Optional[str]) -> None:
    """Endpoints that expose PII or take action are gated by the ADMIN_KEY secret,
    sent as the X-Admin-Key header."""
    admin_key = os.environ.get("ADMIN_KEY")
    if not admin_key:
        raise HTTPException(503, "ADMIN_KEY is not configured on the server.")
    if not x_admin_key or not hmac.compare_digest(x_admin_key, admin_key):
        raise HTTPException(403, "Forbidden")


@api.get("/admin/marketing-emails")
async def get_marketing_emails(
    format: str = "json",
    x_admin_key: Optional[str] = Header(None),
):
    """Export every user who opted in to marketing emails (marketing_consent == True).

    Unlike the other /admin endpoints this returns raw PII (email addresses), so it is
    gated behind the ADMIN_KEY secret: send it as the `X-Admin-Key` request header
    (or an `?key=` won't work — header only). Set ADMIN_KEY in the backend env.
    Pass ?format=csv to download a CSV suitable for import into an email tool.
    """
    _require_admin(x_admin_key)

    docs = await db.users.find(
        {"marketing_consent": True},
        {"_id": 0, "email": 1, "full_name": 1, "country_code": 1, "marketing_consent_at": 1, "created_at": 1},
    ).sort("created_at", -1).to_list(100000)

    if format.lower() == "csv":
        def esc(v: object) -> str:
            s = "" if v is None else str(v)
            if any(c in s for c in [',', '"', '\n', '\r']):
                s = '"' + s.replace('"', '""') + '"'
            return s

        lines = ["email,full_name,country_code,opted_in_at,created_at"]
        for d in docs:
            lines.append(",".join(esc(d.get(k)) for k in
                                  ("email", "full_name", "country_code", "marketing_consent_at", "created_at")))
        csv_body = "\r\n".join(lines) + "\r\n"
        return Response(
            content=csv_body,
            media_type="text/csv",
            headers={"Content-Disposition": "attachment; filename=marketing-emails.csv"},
        )

    return {"total": len(docs), "users": docs}


# ------- Admin: credits -------
class AdminCreditGrantIn(BaseModel):
    credits: float = Field(..., gt=0, le=100000)
    note: Optional[str] = Field(default=None, max_length=200)


def _admin_user_row(d: dict) -> dict:
    return {
        "id": d["id"],
        "full_name": d.get("full_name", ""),
        "email": d.get("email", ""),
        "phone_full": d.get("phone_full"),
        "plan": _effective_plan(d),
        "credits": _tenths_to_credits(_credits_tenths(d)),
        "welcome_gift": bool(d.get("welcome_gift_at")),
        "created_at": d.get("created_at"),
    }


@api.get("/admin/billing/users")
async def admin_billing_users(q: str = "", x_admin_key: Optional[str] = Header(None)):
    """Search users by name, email or phone to see their plan and credits, plus
    purchase totals. Newest accounts first when no search is given."""
    _require_admin(x_admin_key)
    query: dict = {}
    if q.strip():
        rx = {"$regex": re.escape(q.strip()), "$options": "i"}
        query = {"$or": [{"email": rx}, {"full_name": rx}, {"phone_full": rx}]}
    projection = {"_id": 0, "id": 1, "full_name": 1, "email": 1, "phone_full": 1, "plan": 1,
                  "credits_tenths": 1, "welcome_gift_at": 1, "created_at": 1}
    docs, revenue, paying_users = await asyncio.gather(
        db.users.find(query, projection).sort("created_at", -1).limit(25).to_list(25),
        db.payments.aggregate([
            {"$match": {"status": "paid"}},
            {"$group": {"_id": "$currency", "amount": {"$sum": "$amount"}, "count": {"$sum": 1}}},
        ]).to_list(20),
        db.users.count_documents({"credits_tenths": {"$gt": 0}}),
    )
    return {
        "users": [_admin_user_row(d) for d in docs],
        "summary": {
            "users_with_credits": paying_users,
            "revenue": [{"currency": r["_id"] or "?", "amount": round(r["amount"] or 0, 2), "count": r["count"]}
                        for r in revenue],
        },
    }


@api.post("/admin/billing/users/{uid}/credits")
async def admin_grant_credits(uid: str, body: AdminCreditGrantIn, x_admin_key: Optional[str] = Header(None)):
    """Add credits to a user by hand, e.g. a goodwill gift or a refund for a failed send."""
    _require_admin(x_admin_key)
    ok = await _grant_credits(
        uid,
        int(round(body.credits * 10)),
        kind="admin",
        key=f"admin:{uuid.uuid4()}",
        note=(body.note or "").strip() or "Added by Rymind support",
    )
    if not ok:
        raise HTTPException(404, "User not found")
    u = await db.users.find_one({"id": uid}, {"_id": 0})
    return _admin_user_row(u)


# ------- Admin: email broadcast -------
class AdminEmailIn(BaseModel):
    subject: str = Field(..., min_length=1, max_length=150)
    body: str = Field(..., min_length=1, max_length=20000)
    audience: Literal["all", "marketing"] = "marketing"
    cta_label: Optional[str] = Field(default=None, max_length=40)
    cta_url: Optional[str] = Field(default=None, max_length=500)
    test_email: Optional[EmailStr] = None


_URL_RE = re.compile(r"(https?://[^\s<]+)")
_background_tasks: set = set()


def _render_admin_email_body(text: str, first_name: str) -> str:
    """Plain text from the admin composer -> safe HTML: blank lines become paragraphs,
    URLs become links, and {name} becomes the recipient's first name."""
    safe = html_lib.escape(text.replace("{name}", first_name))
    safe = _URL_RE.sub(lambda m: f'<a href="{m.group(1)}" style="color:#2A4B41">{m.group(1)}</a>', safe)
    paragraphs = [p.strip() for p in re.split(r"\n\s*\n", safe) if p.strip()]
    return "".join(f'<p style="margin:0 0 14px">{p.replace(chr(10), "<br>")}</p>' for p in paragraphs)


def _admin_email_params(campaign: dict, recipient: dict) -> dict:
    email = recipient["email"]
    first = ((recipient.get("full_name") or "").strip().split(" ") or [""])[0] or "there"
    footer = "You're receiving this because you have a Rymind account."
    params: dict = {"from": RESEND_FROM, "to": [email], "subject": campaign["subject"]}
    if campaign["audience"] == "marketing":
        unsub = f"{WEB_APP_URL}/unsubscribe?email={quote(email)}"
        footer = (
            "You're receiving this because you opted in to updates from Rymind. "
            f'<a href="{unsub}" style="color:#94978F">Unsubscribe</a>'
        )
        params["headers"] = {"List-Unsubscribe": f"<{unsub}>"}
    params["html"] = _branded_email_html(
        None,
        _render_admin_email_body(campaign["body"], first),
        campaign.get("cta_label"),
        campaign.get("cta_url"),
        footer,
    )
    return params


async def _run_email_campaign(campaign_id: str, recipients: list[dict]) -> None:
    """Send in batches of 100 through Resend's batch API, pausing between calls to
    stay under its rate limit, and keep the campaign's counters current."""
    import resend  # type: ignore

    resend.api_key = RESEND_KEY
    campaign = await db.email_campaigns.find_one({"id": campaign_id}, {"_id": 0})
    if not campaign:
        return
    sent = failed = 0
    last_error = None
    for i in range(0, len(recipients), 100):
        chunk = recipients[i:i + 100]
        try:
            await asyncio.to_thread(resend.Batch.send, [_admin_email_params(campaign, r) for r in chunk])
            sent += len(chunk)
        except Exception as e:
            failed += len(chunk)
            last_error = str(e)[:300]
            logger.warning("[email-campaign] batch %d failed: %s", i // 100, e)
        await db.email_campaigns.update_one({"id": campaign_id}, {"$set": {"sent": sent, "failed": failed}})
        await asyncio.sleep(0.6)
    status_ = "sent" if failed == 0 else ("failed" if sent == 0 else "partial")
    await db.email_campaigns.update_one(
        {"id": campaign_id},
        {"$set": {"status": status_, "last_error": last_error,
                  "finished_at": datetime.now(timezone.utc).isoformat()}},
    )


@api.get("/admin/email/audience")
async def admin_email_audience(x_admin_key: Optional[str] = Header(None)):
    _require_admin(x_admin_key)
    has_email = {"email": {"$exists": True, "$ne": ""}}
    all_count, marketing_count = await asyncio.gather(
        db.users.count_documents(has_email),
        db.users.count_documents({**has_email, "marketing_consent": True}),
    )
    return {"all": all_count, "marketing": marketing_count, "email_ready": bool(RESEND_KEY)}


@api.get("/admin/email/campaigns")
async def admin_email_campaigns(x_admin_key: Optional[str] = Header(None)):
    _require_admin(x_admin_key)
    docs = await db.email_campaigns.find({}, {"_id": 0, "body": 0}).sort("created_at", -1).limit(20).to_list(20)
    return {"campaigns": docs}


@api.post("/admin/email/send")
async def admin_send_email(body: AdminEmailIn, x_admin_key: Optional[str] = Header(None)):
    """Send a branded email to every user (service announcements, e.g. the plan
    change) or only to those who opted in to marketing. Pass test_email to send a
    single preview first."""
    _require_admin(x_admin_key)
    if not RESEND_KEY:
        raise HTTPException(503, "Email sending isn't configured. Set RESEND_API_KEY on the server.")
    cta_label = (body.cta_label or "").strip() or None
    cta_url = (body.cta_url or "").strip() or None
    if bool(cta_label) != bool(cta_url):
        raise HTTPException(400, "Add both a button label and a button link, or leave both empty.")
    if cta_url and not cta_url.startswith(("https://", "http://")):
        raise HTTPException(400, "The button link must start with https://")
    campaign = {
        "subject": body.subject.strip(),
        "body": body.body.strip(),
        "audience": body.audience,
        "cta_label": cta_label,
        "cta_url": cta_url,
    }

    if body.test_email:
        import resend  # type: ignore

        resend.api_key = RESEND_KEY
        params = _admin_email_params(campaign, {"email": str(body.test_email), "full_name": ""})
        params["subject"] = f"[Test] {params['subject']}"
        try:
            await asyncio.to_thread(resend.Emails.send, params)
        except Exception as e:
            logger.warning("[email-campaign] test send failed: %s", e)
            raise HTTPException(502, "The test email couldn't be sent. Check the Resend settings and try again.")
        return {"test": True, "sent_to": str(body.test_email)}

    if await db.email_campaigns.find_one({"status": "sending"}, {"_id": 1}):
        raise HTTPException(409, "Another email is still sending. Wait for it to finish first.")
    query: dict = {"email": {"$exists": True, "$ne": ""}}
    if body.audience == "marketing":
        query["marketing_consent"] = True
    seen: set[str] = set()
    recipients = []
    async for u in db.users.find(query, {"_id": 0, "email": 1, "full_name": 1}):
        email = (u.get("email") or "").strip().lower()
        if email and email not in seen:
            seen.add(email)
            recipients.append({"email": email, "full_name": u.get("full_name")})
    if not recipients:
        raise HTTPException(400, "Nobody is in this audience yet.")
    doc = {
        "id": str(uuid.uuid4()),
        **campaign,
        "status": "sending",
        "total": len(recipients),
        "sent": 0,
        "failed": 0,
        "created_at": datetime.now(timezone.utc).isoformat(),
    }
    await db.email_campaigns.insert_one(doc)
    task = asyncio.create_task(_run_email_campaign(doc["id"], recipients))
    _background_tasks.add(task)
    task.add_done_callback(_background_tasks.discard)
    doc.pop("_id", None)
    doc.pop("body", None)
    return doc


app.include_router(api)


# =====================================================================
# Real-time user WebSocket — broadcasts reminder/contact events to every
# signed-in client (web + mobile) for the authenticated user.
# =====================================================================
@app.websocket("/api/ws/user")
async def ws_user(websocket: WebSocket):
    token = websocket.query_params.get("token")
    user_id: Optional[str] = None
    if token:
        try:
            payload = jwt.decode(token, JWT_SECRET, algorithms=[JWT_ALG])
            user_id = payload.get("sub")
        except jwt.PyJWTError:
            user_id = None
    user = None
    if user_id:
        user = await db.users.find_one({"id": user_id}, {"_id": 0, "password_hash": 0})
    if not user:
        # Accept first so the client receives a structured close with code 4401
        await websocket.accept()
        try:
            await websocket.send_json({"type": "error", "code": "invalid_token"})
        except Exception:
            pass
        await websocket.close(code=4401)
        return

    await websocket.accept()
    _user_sockets.setdefault(user_id, set()).add(websocket)
    logger.info("[ws/user] connected user=%s (total=%d)", user_id, len(_user_sockets[user_id]))

    ping_task: Optional[asyncio.Task] = None

    async def _pinger():
        try:
            while True:
                await asyncio.sleep(30)
                try:
                    await websocket.send_json({"type": "ping"})
                except Exception:
                    break
        except asyncio.CancelledError:
            pass

    try:
        await websocket.send_json({"type": "hello", "user_id": user_id})
        ping_task = asyncio.create_task(_pinger())
        while True:
            # Receive any client message (typically pong); just keep socket alive.
            await websocket.receive_text()
    except WebSocketDisconnect:
        pass
    except Exception as e:
        logger.debug("[ws/user] error for %s: %s", user_id, e)
    finally:
        if ping_task and not ping_task.done():
            ping_task.cancel()
        try:
            _user_sockets.get(user_id, set()).discard(websocket)
            if user_id in _user_sockets and not _user_sockets[user_id]:
                _user_sockets.pop(user_id, None)
        except Exception:
            pass
        try:
            await websocket.close()
        except Exception:
            pass


app.add_middleware(
    CORSMiddleware,
    allow_credentials=True,
    # Use regex (echoes the request's Origin) instead of "*", because the
    # CORS spec forbids wildcard origin together with credentials=True.
    # This safely allows the Emergent preview URLs, localhost, and the web app.
    allow_origin_regex=r".*",
    allow_methods=["*"],
    allow_headers=["*"],
)
