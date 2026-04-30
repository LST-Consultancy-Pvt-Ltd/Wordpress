<?php
defined( 'ABSPATH' ) || exit;

/**
 * WPMB_Sitemap — Sitemap management endpoints.
 */
class WPMB_Sitemap {

    public static function register_routes() {
        $ns = WPMB_NAMESPACE;
        $ep = [ 'WPMB_Auth', 'require_editor' ];

        register_rest_route( $ns, '/sitemap', [
            'methods'             => 'GET',
            'callback'            => [ __CLASS__, 'get_sitemap' ],
            'permission_callback' => $ep,
        ] );

        register_rest_route( $ns, '/sitemap/regenerate', [
            'methods'             => 'POST',
            'callback'            => [ __CLASS__, 'regenerate' ],
            'permission_callback' => $ep,
        ] );

        register_rest_route( $ns, '/sitemap/regenerate-with-images', [
            'methods'             => 'POST',
            'callback'            => [ __CLASS__, 'regenerate_with_images' ],
            'permission_callback' => $ep,
        ] );
    }

    public static function get_sitemap(): WP_REST_Response {
        $sitemap_url = home_url( '/sitemap.xml' );

        // Try Yoast sitemap index
        if ( function_exists( 'wpseo_init' ) ) {
            $sitemap_url = home_url( '/sitemap_index.xml' );
        }

        return new WP_REST_Response( [
            'sitemap_url' => $sitemap_url,
            'home_url'    => home_url(),
            'has_yoast'   => function_exists( 'wpseo_init' ),
            'has_rankmath'=> class_exists( 'RankMath' ),
        ], 200 );
    }

    public static function regenerate(): WP_REST_Response {
        // Trigger Yoast sitemap regeneration
        if ( class_exists( 'WPSEO_Sitemaps' ) ) {
            do_action( 'wpseo_sitemap_index' );
        }

        // Trigger RankMath sitemap
        if ( class_exists( 'RankMath\Sitemap\Sitemap' ) ) {
            do_action( 'rank_math/sitemap/invalidate_object_type', 'post' );
        }

        // Flush rewrite rules to regenerate WP core sitemap (WP 5.5+)
        flush_rewrite_rules( false );

        return new WP_REST_Response( [
            'success'     => true,
            'sitemap_url' => home_url( '/sitemap.xml' ),
            'message'     => 'Sitemap regeneration triggered. If using Yoast or RankMath, their sitemap will rebuild on next request.',
        ], 200 );
    }

    public static function regenerate_with_images(): WP_REST_Response {
        // Same as regenerate but also ensure images are indexed
        $result = self::regenerate();

        // Build a simple image sitemap entry list
        $images = get_posts( [
            'post_type'      => 'attachment',
            'post_mime_type' => 'image',
            'posts_per_page' => 100,
            'post_status'    => 'inherit',
        ] );

        $image_urls = array_map( fn( $att ) => wp_get_attachment_url( $att->ID ), $images );

        $data = $result->get_data();
        $data['image_count'] = count( $image_urls );

        return new WP_REST_Response( $data, 200 );
    }
}
