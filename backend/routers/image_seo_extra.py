"""
Additional image SEO utilities (Module 4): EXIF metadata cleaning,
image sitemap auto-generation, and bulk WebP conversion.
"""
from fastapi import HTTPException, Depends
from pydantic import BaseModel
from typing import List
import httpx
from datetime import datetime, timezone

from core.db import db
from core.security import require_editor
from core.activity import log_activity
from providers.wordpress import get_wp_credentials, wp_api_request
from core.router import api_router

# FEATURE: EXIF Metadata Cleaning (Module 4)
# ========================

class ExifCleanRequest(BaseModel):
    media_ids: List[int] = []

@api_router.post("/images/{site_id}/clean-exif")
async def clean_exif_metadata(site_id: str, data: ExifCleanRequest, _=Depends(require_editor)):
    """Strip EXIF metadata (GPS, camera serial, author) from images."""
    from io import BytesIO
    try:
        from PIL import Image as PILImage
    except ImportError:
        raise HTTPException(status_code=500, detail="Pillow not installed. Run: pip install Pillow")

    site = await get_wp_credentials(site_id, _["id"])
    resp = await wp_api_request(site, "GET", "media?per_page=50&_fields=id,source_url,mime_type&media_type=image")
    if resp.status_code != 200:
        raise HTTPException(status_code=502, detail="Failed to fetch media")

    media_items = resp.json()
    if data.media_ids:
        media_items = [m for m in media_items if m["id"] in data.media_ids]

    results = []
    async with httpx.AsyncClient(timeout=30) as client:
        for item in media_items[:20]:
            mid = item["id"]
            url = item.get("source_url", "")
            mime = item.get("mime_type", "")
            if not mime.startswith("image/"):
                continue
            try:
                img_resp = await client.get(url)
                if img_resp.status_code != 200:
                    results.append({"media_id": mid, "status": "error", "detail": "Failed to download"})
                    continue
                img = PILImage.open(BytesIO(img_resp.content))
                exif_data = img.info.get("exif", b"")
                if not exif_data:
                    results.append({"media_id": mid, "status": "clean", "detail": "No EXIF data found"})
                    continue
                clean_buf = BytesIO()
                img.save(clean_buf, format=img.format or "JPEG")
                clean_buf.seek(0)
                filename = url.split("/")[-1]
                upload_resp = await wp_api_request(site, "POST", f"media/{mid}",
                    data=clean_buf.read(),
                    extra_headers={"Content-Disposition": f'attachment; filename="{filename}"', "Content-Type": mime})
                results.append({"media_id": mid, "status": "cleaned", "exif_removed": True, "original_exif_bytes": len(exif_data)})
            except Exception as e:
                results.append({"media_id": mid, "status": "error", "detail": str(e)})

    cleaned = sum(1 for r in results if r["status"] == "cleaned")
    await log_activity(site_id, "exif_cleaned", f"Cleaned EXIF from {cleaned}/{len(results)} images")
    return {"site_id": site_id, "processed": len(results), "cleaned": cleaned, "results": results}


# ========================
# FEATURE: Image Sitemap Auto-Generation (Module 4)
# ========================

class ImageSitemapRequest(BaseModel):
    include_images: bool = True

@api_router.post("/sitemap/{site_id}/regenerate-with-images")
async def regenerate_sitemap_with_images(site_id: str, data: ImageSitemapRequest = ImageSitemapRequest(), _=Depends(require_editor)):
    """Generate XML sitemap with <image:image> entries for posts/pages with featured images."""
    site = await get_wp_credentials(site_id, _["id"])
    base_url = site.get("url", "").rstrip("/")
    entries = []
    for endpoint in ["posts", "pages"]:
        try:
            resp = await wp_api_request(site, "GET", f"{endpoint}?per_page=100&_fields=id,link,modified,_embedded&_embed=wp:featuredmedia&status=publish")
            if resp.status_code == 200:
                for item in resp.json():
                    entry = {"loc": item.get("link", ""), "lastmod": item.get("modified", ""), "images": []}
                    if data.include_images:
                        embedded = item.get("_embedded", {})
                        for media in (embedded.get("wp:featuredmedia") or []):
                            if isinstance(media, dict) and media.get("source_url"):
                                title_raw = media.get("title", {})
                                caption = title_raw.get("rendered", "") if isinstance(title_raw, dict) else ""
                                entry["images"].append({"loc": media["source_url"], "title": caption or media.get("alt_text", ""), "caption": caption})
                    entries.append(entry)
        except Exception:
            pass

    xml_lines = ['<?xml version="1.0" encoding="UTF-8"?>',
                 '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:image="http://www.google.com/schemas/sitemap-image/1.1">']
    for entry in entries:
        xml_lines.append("  <url>")
        xml_lines.append(f"    <loc>{entry['loc']}</loc>")
        if entry.get("lastmod"):
            xml_lines.append(f"    <lastmod>{entry['lastmod']}</lastmod>")
        for img in entry.get("images", []):
            xml_lines.append("    <image:image>")
            xml_lines.append(f"      <image:loc>{img['loc']}</image:loc>")
            if img.get("title"):
                xml_lines.append(f"      <image:title>{img['title']}</image:title>")
            xml_lines.append("    </image:image>")
        xml_lines.append("  </url>")
    xml_lines.append("</urlset>")
    sitemap_xml = "\n".join(xml_lines)

    img_count = sum(len(e["images"]) for e in entries)
    await db.image_sitemaps.replace_one({"site_id": site_id},
        {"site_id": site_id, "xml": sitemap_xml, "url_count": len(entries), "image_count": img_count,
         "generated_at": datetime.now(timezone.utc).isoformat()}, upsert=True)

    results = []
    async with httpx.AsyncClient(timeout=20, follow_redirects=True) as client:
        for name, ping_url in [("google_ping", f"https://www.google.com/ping?sitemap={base_url}/sitemap.xml"),
                                ("bing_ping", f"https://www.bing.com/ping?sitemap={base_url}/sitemap.xml")]:
            try:
                r = await client.get(ping_url)
                results.append({"target": name, "status": r.status_code})
            except Exception as e:
                results.append({"target": name, "error": str(e)})

    await log_activity(site_id, "image_sitemap_generated", f"Image sitemap: {len(entries)} URLs, {img_count} images")
    return {"ok": True, "url_count": len(entries), "image_count": img_count, "sitemap_preview": sitemap_xml[:3000], "ping_results": results}


# ========================
# FEATURE: WebP Bulk Conversion (Module 4)
# ========================

class WebPConvertRequest(BaseModel):
    media_ids: List[int] = []

@api_router.post("/images/{site_id}/convert-webp")
async def convert_images_to_webp(site_id: str, data: WebPConvertRequest, _=Depends(require_editor)):
    """Download images from WP, convert to WebP using Pillow, re-upload via WP REST API."""
    from io import BytesIO
    try:
        from PIL import Image as PILImage
    except ImportError:
        raise HTTPException(status_code=500, detail="Pillow not installed")

    site = await get_wp_credentials(site_id, _["id"])
    resp = await wp_api_request(site, "GET", "media?per_page=50&_fields=id,source_url,mime_type&media_type=image")
    if resp.status_code != 200:
        raise HTTPException(status_code=502, detail="Failed to fetch media")

    convertible = [m for m in resp.json() if m.get("mime_type") in ("image/jpeg", "image/png", "image/bmp", "image/tiff")]
    if data.media_ids:
        convertible = [m for m in convertible if m["id"] in data.media_ids]

    results = []
    async with httpx.AsyncClient(timeout=30) as client:
        for item in convertible[:20]:
            mid = item["id"]
            url = item.get("source_url", "")
            try:
                img_resp = await client.get(url)
                if img_resp.status_code != 200:
                    results.append({"media_id": mid, "status": "error", "detail": "Download failed"})
                    continue
                original_size = len(img_resp.content)
                img = PILImage.open(BytesIO(img_resp.content))
                webp_buf = BytesIO()
                img.save(webp_buf, format="WEBP", quality=82)
                webp_buf.seek(0)
                webp_size = webp_buf.getbuffer().nbytes
                original_name = url.split("/")[-1].rsplit(".", 1)[0]
                upload_resp = await wp_api_request(site, "POST", "media", data=webp_buf.read(),
                    extra_headers={"Content-Disposition": f'attachment; filename="{original_name}.webp"', "Content-Type": "image/webp"})
                new_id = upload_resp.json().get("id") if upload_resp.status_code == 201 else None
                results.append({"media_id": mid, "status": "converted", "original_size": original_size,
                    "webp_size": webp_size, "savings_pct": round((1 - webp_size / max(original_size, 1)) * 100, 1), "new_media_id": new_id})
            except Exception as e:
                results.append({"media_id": mid, "status": "error", "detail": str(e)})

    converted = sum(1 for r in results if r["status"] == "converted")
    total_saved = sum(r.get("original_size", 0) - r.get("webp_size", 0) for r in results if r["status"] == "converted")
    await log_activity(site_id, "webp_conversion", f"Converted {converted}/{len(results)} images to WebP, saved {total_saved} bytes")
    return {"site_id": site_id, "converted": converted, "total_saved_bytes": total_saved, "results": results}
