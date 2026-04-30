<?php
defined( 'ABSPATH' ) || exit;

/**
 * WPMB_Media — Extended media library endpoints.
 *
 * Standard media upload/delete is already in WP REST API (wp/v2/media).
 * These endpoints add: rename, compress (requires GD/Imagick), bulk-compress,
 * alt-text audit, AI alt-text generation stub, EXIF cleaning, WebP conversion.
 */
class WPMB_Media {

    public static function register_routes() {
        $ns = WPMB_NAMESPACE;
        $ep = [ 'WPMB_Auth', 'require_editor' ];

        register_rest_route( $ns, '/media', [
            'methods'             => 'GET',
            'callback'            => [ __CLASS__, 'get_media' ],
            'permission_callback' => $ep,
        ] );

        register_rest_route( $ns, '/media/(?P<media_id>\d+)', [
            'methods'             => 'DELETE',
            'callback'            => [ __CLASS__, 'delete_media' ],
            'permission_callback' => $ep,
        ] );

        register_rest_route( $ns, '/media/rename/(?P<media_id>\d+)', [
            'methods'             => 'POST',
            'callback'            => [ __CLASS__, 'rename_media' ],
            'permission_callback' => $ep,
        ] );

        register_rest_route( $ns, '/media/compress/(?P<media_id>\d+)', [
            'methods'             => 'POST',
            'callback'            => [ __CLASS__, 'compress_media' ],
            'permission_callback' => $ep,
        ] );

        register_rest_route( $ns, '/media/bulk-compress', [
            'methods'             => 'POST',
            'callback'            => [ __CLASS__, 'bulk_compress' ],
            'permission_callback' => $ep,
        ] );

        register_rest_route( $ns, '/media/upload', [
            'methods'             => 'POST',
            'callback'            => [ __CLASS__, 'upload_media' ],
            'permission_callback' => $ep,
        ] );

        // Image alt text audit
        register_rest_route( $ns, '/images/audit', [
            [
                'methods'             => 'GET',
                'callback'            => [ __CLASS__, 'get_image_audit' ],
                'permission_callback' => $ep,
            ],
            [
                'methods'             => 'POST',
                'callback'            => [ __CLASS__, 'run_image_audit' ],
                'permission_callback' => $ep,
            ],
        ] );

        // Generate alt text for single image (stub — real AI in backend)
        register_rest_route( $ns, '/images/generate-alt/(?P<media_id>\d+)', [
            'methods'             => 'POST',
            'callback'            => [ __CLASS__, 'generate_alt_text' ],
            'permission_callback' => $ep,
        ] );

        // Apply alt text written by the backend AI
        register_rest_route( $ns, '/images/apply-alt/(?P<media_id>\d+)', [
            'methods'             => 'POST',
            'callback'            => [ __CLASS__, 'apply_alt_text' ],
            'permission_callback' => $ep,
        ] );

        // Bulk apply alt texts
        register_rest_route( $ns, '/images/bulk-apply-alts', [
            'methods'             => 'POST',
            'callback'            => [ __CLASS__, 'bulk_apply_alts' ],
            'permission_callback' => $ep,
        ] );

        // Clean EXIF metadata
        register_rest_route( $ns, '/images/clean-exif', [
            'methods'             => 'POST',
            'callback'            => [ __CLASS__, 'clean_exif' ],
            'permission_callback' => $ep,
        ] );

        // WebP conversion
        register_rest_route( $ns, '/images/convert-webp', [
            'methods'             => 'POST',
            'callback'            => [ __CLASS__, 'convert_webp' ],
            'permission_callback' => $ep,
        ] );
    }

    public static function get_media(): WP_REST_Response {
        $media = get_posts( [
            'post_type'      => 'attachment',
            'posts_per_page' => 200,
            'post_status'    => 'inherit',
            'orderby'        => 'date',
            'order'          => 'DESC',
        ] );

        $result = array_map( function( $m ) {
            $metadata = wp_get_attachment_metadata( $m->ID );
            return [
                'id'          => $m->ID,
                'title'       => $m->post_title,
                'filename'    => basename( get_attached_file( $m->ID ) ),
                'url'         => wp_get_attachment_url( $m->ID ),
                'mime_type'   => $m->post_mime_type,
                'alt'         => get_post_meta( $m->ID, '_wp_attachment_image_alt', true ),
                'date'        => $m->post_date,
                'filesize'    => $metadata['filesize'] ?? null,
                'width'       => $metadata['width'] ?? null,
                'height'      => $metadata['height'] ?? null,
            ];
        }, $media );

        return new WP_REST_Response( $result, 200 );
    }

    public static function delete_media( WP_REST_Request $request ): WP_REST_Response {
        $id = (int) $request['media_id'];
        if ( ! wp_delete_attachment( $id, true ) ) {
            return new WP_REST_Response( [ 'error' => 'Failed to delete attachment' ], 400 );
        }
        return new WP_REST_Response( [ 'success' => true, 'id' => $id ], 200 );
    }

    public static function rename_media( WP_REST_Request $request ): WP_REST_Response {
        $id       = (int) $request['media_id'];
        $new_name = sanitize_text_field( $request->get_param( 'name' ) ?? '' );

        if ( ! $new_name ) {
            return new WP_REST_Response( [ 'error' => 'Name is required' ], 400 );
        }

        $result = wp_update_post( [ 'ID' => $id, 'post_title' => $new_name ], true );
        if ( is_wp_error( $result ) ) {
            return new WP_REST_Response( [ 'error' => $result->get_error_message() ], 400 );
        }

        return new WP_REST_Response( [ 'success' => true, 'id' => $id, 'name' => $new_name ], 200 );
    }

    public static function compress_media( WP_REST_Request $request ): WP_REST_Response {
        $id       = (int) $request['media_id'];
        $file     = get_attached_file( $id );
        $quality  = max( 10, min( 100, (int) ( $request->get_param( 'quality' ) ?? 82 ) ) );

        if ( ! $file || ! file_exists( $file ) ) {
            return new WP_REST_Response( [ 'error' => 'File not found' ], 404 );
        }

        $before = filesize( $file );
        $mime   = mime_content_type( $file );

        $compressed = self::compress_image_file( $file, $mime, $quality );

        if ( ! $compressed ) {
            return new WP_REST_Response( [ 'error' => 'Compression failed or not supported for this format' ], 400 );
        }

        clearstatcache( true, $file );
        $after = filesize( $file );

        return new WP_REST_Response( [
            'success'   => true,
            'id'        => $id,
            'before'    => $before,
            'after'     => $after,
            'saved'     => $before - $after,
            'saved_pct' => $before > 0 ? round( ( ( $before - $after ) / $before ) * 100, 1 ) : 0,
        ], 200 );
    }

    public static function bulk_compress(): WP_REST_Response {
        $attachments = get_posts( [
            'post_type'      => 'attachment',
            'posts_per_page' => 100,
            'post_mime_type' => [ 'image/jpeg', 'image/png' ],
            'post_status'    => 'inherit',
        ] );

        $results   = [];
        $total_saved = 0;

        foreach ( $attachments as $att ) {
            $file = get_attached_file( $att->ID );
            if ( ! $file || ! file_exists( $file ) ) continue;
            $before = filesize( $file );
            $mime   = mime_content_type( $file );
            self::compress_image_file( $file, $mime, 82 );
            clearstatcache( true, $file );
            $after       = filesize( $file );
            $saved       = $before - $after;
            $total_saved += max( 0, $saved );
            $results[]   = [ 'id' => $att->ID, 'saved' => max( 0, $saved ) ];
        }

        return new WP_REST_Response( [
            'success'     => true,
            'count'       => count( $results ),
            'total_saved' => $total_saved,
            'results'     => $results,
        ], 200 );
    }

    public static function upload_media( WP_REST_Request $request ): WP_REST_Response {
        // Accept raw binary body with X-Filename header
        $filename = sanitize_file_name( $request->get_header( 'x-filename' ) ?? 'upload' );
        $body     = $request->get_body();

        if ( empty( $body ) ) {
            return new WP_REST_Response( [ 'error' => 'No file data received' ], 400 );
        }

        require_once ABSPATH . 'wp-admin/includes/file.php';
        require_once ABSPATH . 'wp-admin/includes/media.php';
        require_once ABSPATH . 'wp-admin/includes/image.php';

        $upload_dir = wp_upload_dir();
        $tmp_file   = $upload_dir['basedir'] . '/' . $filename;
        file_put_contents( $tmp_file, $body );

        $file_array = [
            'name'     => $filename,
            'tmp_name' => $tmp_file,
            'error'    => 0,
            'size'     => strlen( $body ),
        ];

        $attachment_id = media_handle_sideload( $file_array, 0 );

        if ( is_wp_error( $attachment_id ) ) {
            @unlink( $tmp_file );
            return new WP_REST_Response( [ 'error' => $attachment_id->get_error_message() ], 400 );
        }

        return new WP_REST_Response( [
            'success' => true,
            'id'      => $attachment_id,
            'url'     => wp_get_attachment_url( $attachment_id ),
        ], 201 );
    }

    public static function get_image_audit(): WP_REST_Response {
        $audit = get_option( 'wpmb_image_audit', [] );
        return new WP_REST_Response( $audit, 200 );
    }

    public static function run_image_audit(): WP_REST_Response {
        $attachments = get_posts( [
            'post_type'      => 'attachment',
            'posts_per_page' => -1,
            'post_mime_type' => 'image',
            'post_status'    => 'inherit',
        ] );

        $missing_alt = [];
        foreach ( $attachments as $att ) {
            $alt = get_post_meta( $att->ID, '_wp_attachment_image_alt', true );
            if ( empty( trim( $alt ) ) ) {
                $missing_alt[] = [
                    'id'       => $att->ID,
                    'title'    => $att->post_title,
                    'url'      => wp_get_attachment_url( $att->ID ),
                    'filename' => basename( get_attached_file( $att->ID ) ),
                ];
            }
        }

        $result = [
            'total_images'    => count( $attachments ),
            'missing_alt'     => count( $missing_alt ),
            'missing_alt_ids' => $missing_alt,
            'scanned_at'      => current_time( 'mysql' ),
        ];

        update_option( 'wpmb_image_audit', $result );

        return new WP_REST_Response( $result, 200 );
    }

    public static function generate_alt_text( WP_REST_Request $request ): WP_REST_Response {
        // The actual AI generation happens in the backend.
        // This endpoint returns the current alt text and image URL
        // so the backend can generate the alt text and call apply-alt.
        $id  = (int) $request['media_id'];
        $url = wp_get_attachment_url( $id );
        $alt = get_post_meta( $id, '_wp_attachment_image_alt', true );

        return new WP_REST_Response( [
            'id'          => $id,
            'url'         => $url,
            'current_alt' => $alt,
            'filename'    => basename( get_attached_file( $id ) ),
            'title'       => get_the_title( $id ),
        ], 200 );
    }

    public static function apply_alt_text( WP_REST_Request $request ): WP_REST_Response {
        $id  = (int) $request['media_id'];
        $alt = sanitize_text_field( $request->get_param( 'alt_text' ) ?? '' );
        update_post_meta( $id, '_wp_attachment_image_alt', $alt );
        return new WP_REST_Response( [ 'success' => true, 'id' => $id, 'alt_text' => $alt ], 200 );
    }

    public static function bulk_apply_alts( WP_REST_Request $request ): WP_REST_Response {
        $items   = (array) ( $request->get_param( 'items' ) ?? [] );
        $results = [];
        foreach ( $items as $item ) {
            $id  = (int) ( $item['id'] ?? 0 );
            $alt = sanitize_text_field( $item['alt_text'] ?? '' );
            if ( $id && $alt ) {
                update_post_meta( $id, '_wp_attachment_image_alt', $alt );
                $results[] = [ 'id' => $id, 'ok' => true ];
            }
        }
        return new WP_REST_Response( [ 'success' => true, 'updated' => count( $results ), 'results' => $results ], 200 );
    }

    public static function clean_exif(): WP_REST_Response {
        // Requires Imagick
        if ( ! extension_loaded( 'imagick' ) ) {
            return new WP_REST_Response( [ 'error' => 'Imagick extension not available' ], 501 );
        }

        $attachments = get_posts( [
            'post_type'      => 'attachment',
            'post_mime_type' => 'image/jpeg',
            'posts_per_page' => 50,
            'post_status'    => 'inherit',
        ] );

        $cleaned = 0;
        foreach ( $attachments as $att ) {
            $file = get_attached_file( $att->ID );
            if ( ! $file || ! file_exists( $file ) ) continue;
            try {
                $img = new Imagick( $file );
                $img->stripImage();
                $img->writeImage( $file );
                $img->destroy();
                $cleaned++;
            } catch ( Exception $e ) {
                // skip
            }
        }

        return new WP_REST_Response( [ 'success' => true, 'cleaned' => $cleaned ], 200 );
    }

    public static function convert_webp(): WP_REST_Response {
        if ( ! function_exists( 'imagewebp' ) ) {
            return new WP_REST_Response( [ 'error' => 'GD WebP support not available' ], 501 );
        }

        $attachments = get_posts( [
            'post_type'      => 'attachment',
            'post_mime_type' => [ 'image/jpeg', 'image/png' ],
            'posts_per_page' => 50,
            'post_status'    => 'inherit',
        ] );

        $converted = 0;
        foreach ( $attachments as $att ) {
            $file = get_attached_file( $att->ID );
            if ( ! $file || ! file_exists( $file ) ) continue;
            $webp_file = preg_replace( '/\.(jpe?g|png)$/i', '.webp', $file );
            $mime      = mime_content_type( $file );
            $src       = null;

            if ( $mime === 'image/jpeg' ) {
                $src = @imagecreatefromjpeg( $file );
            } elseif ( $mime === 'image/png' ) {
                $src = @imagecreatefrompng( $file );
            }

            if ( $src && imagewebp( $src, $webp_file, 82 ) ) {
                imagedestroy( $src );
                $converted++;
            }
        }

        return new WP_REST_Response( [ 'success' => true, 'converted' => $converted ], 200 );
    }

    /* -------------------------------------------------------
     *  Helper
     * ----------------------------------------------------- */
    private static function compress_image_file( string $file, string $mime, int $quality ): bool {
        if ( $mime === 'image/jpeg' ) {
            $img = @imagecreatefromjpeg( $file );
            if ( ! $img ) return false;
            imagejpeg( $img, $file, $quality );
            imagedestroy( $img );
            return true;
        }
        if ( $mime === 'image/png' ) {
            $img = @imagecreatefrompng( $file );
            if ( ! $img ) return false;
            // PNG quality is 0-9
            imagepng( $img, $file, (int) floor( ( 100 - $quality ) / 11 ) );
            imagedestroy( $img );
            return true;
        }
        return false;
    }
}
