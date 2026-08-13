"""Downloadable WordPress companion plugins: the SEO Meta Fields REST API Fixer
(registers Yoast/RankMath meta fields as REST-writable) and the WP Manager
Bridge plugin (writes SEO meta directly via update_post_meta(), bypassing REST
and XML-RPC field restrictions).
"""
import io
import os
import zipfile

from fastapi import Depends, HTTPException
from fastapi.responses import Response

from core.router import api_router
from core.security import require_editor

_META_FIXER_PHP = """\
<?php
/**
 * Plugin Name: LST SEO Meta Fields REST API Fixer
 * Description: Registers Yoast SEO and RankMath meta fields as read/writable via the WordPress REST API so the LST Platform can update SEO titles and descriptions.
 * Version: 1.0.0
 * Author: LST Platform
 */
if ( ! defined( 'ABSPATH' ) ) {
    exit;
}

add_action( 'init', function () {
    $fields = [
        // Yoast SEO
        '_yoast_wpseo_title',
        '_yoast_wpseo_metadesc',
        '_yoast_wpseo_focuskw',
        '_yoast_wpseo_canonical',
        '_yoast_wpseo_opengraph-title',
        '_yoast_wpseo_opengraph-description',
        '_yoast_wpseo_opengraph-image',
        // RankMath
        'rank_math_title',
        'rank_math_description',
        'rank_math_focus_keyword',
    ];
    $auth = static function () {
        return current_user_can( 'edit_posts' );
    };
    foreach ( [ 'post', 'page' ] as $type ) {
        foreach ( $fields as $key ) {
            register_post_meta( $type, $key, [
                'show_in_rest'  => true,
                'single'        => true,
                'type'          => 'string',
                'auth_callback' => $auth,
            ] );
        }
    }
}, 20 );
"""


@api_router.get("/seo/meta-fixer-plugin/{site_id}")
async def download_meta_fixer_plugin(site_id: str, _: dict = Depends(require_editor)):
    """Return a ZIP containing a WordPress plugin that exposes Yoast/RankMath meta fields
    via the REST API.  Upload via WP Admin → Plugins → Upload Plugin, then activate it."""
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, mode="w", compression=zipfile.ZIP_DEFLATED) as zf:
        zf.writestr("lst-seo-meta-fixer/lst-seo-meta-fixer.php", _META_FIXER_PHP)
    buf.seek(0)
    return Response(
        content=buf.read(),
        media_type="application/zip",
        headers={"Content-Disposition": 'attachment; filename="lst-seo-meta-fixer.zip"'},
    )


@api_router.get("/seo/bridge-plugin/{site_id}")
async def download_bridge_plugin(site_id: str, _: dict = Depends(require_editor)):
    """Return a ZIP of the WP Manager Bridge plugin.
    This plugin writes SEO meta directly via update_post_meta(), bypassing REST API registration
    restrictions and XML-RPC protected-field limitations.  It is the most reliable path for
    writing Yoast / RankMath meta fields from an external app.
    Install via WP Admin → Plugins → Add New → Upload Plugin."""
    plugin_dir = os.path.join(os.path.dirname(__file__), "..", "..", ".tmp_plugin", "wp-manager-bridge")
    plugin_dir = os.path.normpath(plugin_dir)

    buf = io.BytesIO()
    with zipfile.ZipFile(buf, mode="w", compression=zipfile.ZIP_DEFLATED) as zf:
        if os.path.isdir(plugin_dir):
            for root, dirs, files in os.walk(plugin_dir):
                # Skip hidden dirs and node_modules if accidentally present
                dirs[:] = [d for d in dirs if not d.startswith(".")]
                for fname in files:
                    if fname.startswith("."):
                        continue
                    abs_path = os.path.join(root, fname)
                    rel_path = os.path.relpath(abs_path, os.path.dirname(plugin_dir))
                    zf.write(abs_path, rel_path)
        else:
            raise HTTPException(status_code=404, detail="Bridge plugin source not found on server.")
    buf.seek(0)
    return Response(
        content=buf.read(),
        media_type="application/zip",
        headers={"Content-Disposition": 'attachment; filename="wp-manager-bridge.zip"'},
    )
