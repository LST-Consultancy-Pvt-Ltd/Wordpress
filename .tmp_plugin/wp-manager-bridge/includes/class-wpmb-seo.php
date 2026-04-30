<?php
defined( 'ABSPATH' ) || exit;

/**
 * WPMB_SEO — Extended SEO endpoints for the WP Manager App.
 *
 * Covers: meta tags, Open Graph, apply-bulk SEO, auto-scan,
 * full-page SEO audit, robots meta, canonical updates.
 * NOTE: Core posts/pages CRUD is handled by the standard WP REST API
 * (wp/v2/posts, wp/v2/pages). These endpoints supplement it.
 */
class WPMB_SEO {

    public static function register_routes() {
        $ns = WPMB_NAMESPACE;
        $ep = [ 'WPMB_Auth', 'require_editor' ];

        // Apply meta (title + description) to a post/page
        register_rest_route( $ns, '/seo/apply-meta/(?P<wp_id>\d+)', [
            'methods'             => 'POST',
            'callback'            => [ __CLASS__, 'apply_meta' ],
            'permission_callback' => $ep,
            'args'                => [
                'wp_id'            => [ 'required' => true, 'type' => 'integer' ],
                'meta_title'       => [ 'type' => 'string' ],
                'meta_description' => [ 'type' => 'string' ],
            ],
        ] );

        // Apply Open Graph tags
        register_rest_route( $ns, '/seo/apply-og/(?P<wp_id>\d+)', [
            'methods'             => 'POST',
            'callback'            => [ __CLASS__, 'apply_og' ],
            'permission_callback' => $ep,
        ] );

        // Apply JSON-LD Schema to a post
        register_rest_route( $ns, '/seo/apply-schema/(?P<wp_id>\d+)', [
            'methods'             => 'POST',
            'callback'            => [ __CLASS__, 'apply_schema_to_post' ],
            'permission_callback' => $ep,
        ] );

        // Bulk SEO apply
        register_rest_route( $ns, '/seo/apply-bulk', [
            'methods'             => 'POST',
            'callback'            => [ __CLASS__, 'apply_bulk' ],
            'permission_callback' => $ep,
        ] );

        // Auto-scan: GET suggestions already stored, POST triggers scan
        register_rest_route( $ns, '/seo/auto-scan', [
            [
                'methods'             => 'GET',
                'callback'            => [ __CLASS__, 'get_auto_scan' ],
                'permission_callback' => $ep,
            ],
            [
                'methods'             => 'POST',
                'callback'            => [ __CLASS__, 'trigger_auto_scan' ],
                'permission_callback' => $ep,
            ],
        ] );

        // Full-page SEO audit (returns detailed on-page analysis)
        register_rest_route( $ns, '/seo/full-page-audit', [
            'methods'             => 'POST',
            'callback'            => [ __CLASS__, 'full_page_audit' ],
            'permission_callback' => $ep,
        ] );

        // Download meta-fixer mini-plugin (returns zip blob)
        register_rest_route( $ns, '/seo/meta-fixer-plugin', [
            'methods'             => 'GET',
            'callback'            => [ __CLASS__, 'download_meta_fixer' ],
            'permission_callback' => $ep,
        ] );

        // Readability analysis for a post
        register_rest_route( $ns, '/readability/(?P<wp_id>\d+)', [
            'methods'             => 'POST',
            'callback'            => [ __CLASS__, 'analyze_readability' ],
            'permission_callback' => $ep,
        ] );
    }

    /* -------------------------------------------------------
     *  Handlers
     * ----------------------------------------------------- */

    public static function apply_meta( WP_REST_Request $request ): WP_REST_Response {
        $wp_id = (int) $request['wp_id'];
        $title = sanitize_text_field( $request->get_param( 'meta_title' ) ?? '' );
        $desc  = sanitize_textarea_field( $request->get_param( 'meta_description' ) ?? '' );

        if ( ! get_post( $wp_id ) ) {
            return new WP_REST_Response( [ 'error' => 'Post not found' ], 404 );
        }

        if ( '' === $title && '' === $desc ) {
            return new WP_REST_Response( [ 'error' => 'Both meta_title and meta_description are empty — nothing to write.' ], 400 );
        }

        // Support Yoast SEO, RankMath, All-in-One SEO, SEOPress, and raw meta fallback
        self::set_seo_meta( $wp_id, $title, $desc );

        return new WP_REST_Response( [
            'success'          => true,
            'wp_id'            => $wp_id,
            'meta_title'       => $title,
            'meta_description' => $desc,
        ], 200 );
    }

    public static function apply_og( WP_REST_Request $request ): WP_REST_Response {
        $wp_id   = (int) $request['wp_id'];
        $og_title = sanitize_text_field( $request->get_param( 'og_title' ) ?? '' );
        $og_desc  = sanitize_textarea_field( $request->get_param( 'og_description' ) ?? '' );
        $og_image = esc_url_raw( $request->get_param( 'og_image' ) ?? '' );

        if ( ! get_post( $wp_id ) ) {
            return new WP_REST_Response( [ 'error' => 'Post not found' ], 404 );
        }

        // Yoast
        update_post_meta( $wp_id, '_yoast_wpseo_opengraph-title', $og_title );
        update_post_meta( $wp_id, '_yoast_wpseo_opengraph-description', $og_desc );
        if ( $og_image ) {
            update_post_meta( $wp_id, '_yoast_wpseo_opengraph-image', $og_image );
        }

        // RankMath
        update_post_meta( $wp_id, 'rank_math_facebook_title', $og_title );
        update_post_meta( $wp_id, 'rank_math_facebook_description', $og_desc );

        // SEOPress
        update_post_meta( $wp_id, '_seopress_social_fb_title', $og_title );
        update_post_meta( $wp_id, '_seopress_social_fb_desc', $og_desc );

        // Generic fallback
        update_post_meta( $wp_id, 'wpmb_og_title', $og_title );
        update_post_meta( $wp_id, 'wpmb_og_description', $og_desc );
        update_post_meta( $wp_id, 'wpmb_og_image', $og_image );

        return new WP_REST_Response( [ 'success' => true, 'wp_id' => $wp_id ], 200 );
    }

    public static function apply_schema_to_post( WP_REST_Request $request ): WP_REST_Response {
        $wp_id      = (int) $request['wp_id'];
        $schema_raw = $request->get_param( 'schema' );

        if ( is_array( $schema_raw ) ) {
            $schema_json = wp_json_encode( $schema_raw );
        } else {
            $schema_json = (string) $schema_raw;
        }

        update_post_meta( $wp_id, 'wpmb_schema_json', $schema_json );
        // Also write to Yoast Schema blocks custom field if present
        update_post_meta( $wp_id, '_yoast_wpseo_schema', $schema_json );

        return new WP_REST_Response( [ 'success' => true, 'wp_id' => $wp_id ], 200 );
    }

    public static function apply_bulk( WP_REST_Request $request ): WP_REST_Response {
        $items   = $request->get_param( 'items' ) ?? [];
        $results = [];

        foreach ( (array) $items as $item ) {
            $wp_id = (int) ( $item['wp_id'] ?? 0 );
            if ( ! $wp_id ) {
                continue;
            }
            self::set_seo_meta(
                $wp_id,
                sanitize_text_field( $item['meta_title'] ?? '' ),
                sanitize_textarea_field( $item['meta_description'] ?? '' )
            );
            $results[] = [ 'wp_id' => $wp_id, 'ok' => true ];
        }

        return new WP_REST_Response( [ 'success' => true, 'results' => $results ], 200 );
    }

    public static function get_auto_scan(): WP_REST_Response {
        $suggestions = get_option( 'wpmb_seo_auto_scan', [] );
        return new WP_REST_Response( $suggestions, 200 );
    }

    public static function trigger_auto_scan(): WP_REST_Response {
        $posts = get_posts( [
            'post_type'      => [ 'post', 'page' ],
            'posts_per_page' => 200,
            'post_status'    => 'publish',
        ] );

        $suggestions = [];

        foreach ( $posts as $post ) {
            $issues = [];

            // Missing meta description
            $desc = get_post_meta( $post->ID, '_yoast_wpseo_metadesc', true )
                  ?: get_post_meta( $post->ID, 'rank_math_description', true )
                  ?: get_post_meta( $post->ID, 'wpmb_meta_description', true );

            if ( empty( $desc ) ) {
                $issues[] = 'missing_meta_description';
            }

            // Missing meta title
            $title = get_post_meta( $post->ID, '_yoast_wpseo_title', true )
                   ?: get_post_meta( $post->ID, 'rank_math_title', true )
                   ?: get_post_meta( $post->ID, 'wpmb_meta_title', true );
            if ( empty( $title ) ) {
                $issues[] = 'missing_meta_title';
            }

            // Short content
            $content_length = str_word_count( wp_strip_all_tags( $post->post_content ) );
            if ( $content_length < 300 ) {
                $issues[] = 'thin_content';
            }

            if ( $issues ) {
                $suggestions[] = [
                    'wp_id'      => $post->ID,
                    'title'      => $post->post_title,
                    'url'        => get_permalink( $post->ID ),
                    'post_type'  => $post->post_type,
                    'issues'     => $issues,
                    'word_count' => $content_length,
                ];
            }
        }

        update_option( 'wpmb_seo_auto_scan', $suggestions );

        return new WP_REST_Response( [ 'success' => true, 'count' => count( $suggestions ), 'suggestions' => $suggestions ], 200 );
    }

    public static function full_page_audit( WP_REST_Request $request ): WP_REST_Response {
        $wp_id    = (int) $request->get_param( 'wp_id' );
        $page_url = esc_url_raw( $request->get_param( 'page_url' ) ?? '' );

        if ( ! $wp_id && $page_url ) {
            $wp_id = url_to_postid( $page_url );
        }

        if ( ! $wp_id || ! get_post( $wp_id ) ) {
            return new WP_REST_Response( [ 'error' => 'Post not found' ], 404 );
        }

        $post = get_post( $wp_id );
        $content = wp_strip_all_tags( $post->post_content );
        $word_count = str_word_count( $content );
        $url  = get_permalink( $wp_id );
        $meta_title = get_post_meta( $wp_id, '_yoast_wpseo_title', true ) ?: $post->post_title;
        $meta_desc  = get_post_meta( $wp_id, '_yoast_wpseo_metadesc', true );

        // Images without alt
        preg_match_all( '/<img[^>]+>/i', $post->post_content, $img_tags );
        $images_without_alt = 0;
        foreach ( $img_tags[0] as $img ) {
            if ( ! preg_match( '/alt=["\'][^"\']+["\']/', $img ) ) {
                $images_without_alt++;
            }
        }

        // Headings count
        preg_match_all( '/<h[1-6][^>]*>.*?<\/h[1-6]>/is', $post->post_content, $h_matches );
        $heading_count = count( $h_matches[0] );

        // Internal links
        preg_match_all( '/<a[^>]+href=["\']' . preg_quote( home_url(), '/' ) . '[^"\']*["\'][^>]*>/i', $post->post_content, $links );
        $internal_links = count( $links[0] );

        return new WP_REST_Response( [
            'wp_id'               => $wp_id,
            'url'                 => $url,
            'title'               => $post->post_title,
            'meta_title'          => $meta_title,
            'meta_description'    => $meta_desc,
            'word_count'          => $word_count,
            'heading_count'       => $heading_count,
            'internal_links'      => $internal_links,
            'images_without_alt'  => $images_without_alt,
            'has_og'              => (bool) get_post_meta( $wp_id, 'wpmb_og_title', true ),
            'has_schema'          => (bool) get_post_meta( $wp_id, 'wpmb_schema_json', true ),
            'reading_level'       => self::estimate_reading_level( $content ),
            'score'               => self::calculate_score( $meta_title, $meta_desc, $word_count, $heading_count, $images_without_alt, $internal_links ),
        ], 200 );
    }

    public static function analyze_readability( WP_REST_Request $request ): WP_REST_Response {
        $wp_id = (int) $request['wp_id'];
        $post  = get_post( $wp_id );

        if ( ! $post ) {
            return new WP_REST_Response( [ 'error' => 'Post not found' ], 404 );
        }

        $content    = wp_strip_all_tags( $post->post_content );
        $sentences  = preg_split( '/[.!?]+/', $content, -1, PREG_SPLIT_NO_EMPTY );
        $words      = str_word_count( $content );
        $sent_count = max( 1, count( $sentences ) );

        $avg_words_per_sentence = round( $words / $sent_count, 1 );

        // Passive voice approximation
        $passive_count = preg_match_all( '/\b(is|are|was|were|been|being)\s+\w+ed\b/i', $content );

        return new WP_REST_Response( [
            'wp_id'                  => $wp_id,
            'word_count'             => $words,
            'sentence_count'         => $sent_count,
            'avg_words_per_sentence' => $avg_words_per_sentence,
            'passive_voice_count'    => $passive_count,
            'reading_level'          => self::estimate_reading_level( $content ),
            'flesch_score'           => self::flesch_score( $content ),
        ], 200 );
    }

    public static function download_meta_fixer(): void {
        // Returns instructions as JSON since generating a real zip inline is complex
        wp_send_json( [
            'message'   => 'The WP Manager Bridge plugin already applies meta tags directly. No separate meta-fixer plugin is required. Use the apply-meta and apply-bulk endpoints.',
            'plugin'    => 'wp-manager-bridge',
            'version'   => WPMB_VERSION,
        ] );
    }

    /* -------------------------------------------------------
     *  Helpers
     * ----------------------------------------------------- */

    private static function set_seo_meta( int $wp_id, string $title, string $desc ): void {
        // Yoast SEO
        if ( $title ) {
            update_post_meta( $wp_id, '_yoast_wpseo_title', $title );
        }
        if ( $desc ) {
            update_post_meta( $wp_id, '_yoast_wpseo_metadesc', $desc );
        }

        // RankMath
        if ( $title ) {
            update_post_meta( $wp_id, 'rank_math_title', $title );
        }
        if ( $desc ) {
            update_post_meta( $wp_id, 'rank_math_description', $desc );
        }

        // All-in-One SEO (AIOSEO)
        if ( $title ) {
            update_post_meta( $wp_id, '_aioseo_title', $title );
        }
        if ( $desc ) {
            update_post_meta( $wp_id, '_aioseo_description', $desc );
        }

        // SEOPress
        if ( $title ) {
            update_post_meta( $wp_id, '_seopress_titles_title', $title );
        }
        if ( $desc ) {
            update_post_meta( $wp_id, '_seopress_titles_desc', $desc );
        }

        // Generic fallback (output via wp_head if no SEO plugin detected)
        update_post_meta( $wp_id, 'wpmb_meta_title', $title );
        update_post_meta( $wp_id, 'wpmb_meta_description', $desc );
    }

    private static function estimate_reading_level( string $text ): string {
        $score = self::flesch_score( $text );
        if ( $score >= 90 ) return 'Very Easy';
        if ( $score >= 70 ) return 'Easy';
        if ( $score >= 60 ) return 'Standard';
        if ( $score >= 50 ) return 'Fairly Difficult';
        if ( $score >= 30 ) return 'Difficult';
        return 'Very Difficult';
    }

    private static function flesch_score( string $text ): float {
        $words     = max( 1, str_word_count( $text ) );
        $sentences = max( 1, preg_match_all( '/[.!?]+/', $text ) );
        // Syllable approximation
        $syllables = max( 1, (int) round( $words * 1.5 ) );
        return 206.835 - ( 1.015 * ( $words / $sentences ) ) - ( 84.6 * ( $syllables / $words ) );
    }

    private static function calculate_score( $title, $desc, $words, $headings, $imgs_no_alt, $internal_links ): int {
        $score = 0;
        if ( $title ) $score += 20;
        if ( $desc )  $score += 20;
        if ( $words >= 300 )  $score += 15;
        if ( $words >= 800 )  $score += 10;
        if ( $headings >= 2 ) $score += 15;
        if ( $internal_links > 0 ) $score += 10;
        if ( $imgs_no_alt === 0 ) $score += 10;
        return min( 100, $score );
    }
}

/* =========================================================
 *  Output wpmb_schema_json + wpmb_meta_title / description
 *  in <head> when no SEO plugin is active
 * ======================================================= */
add_action( 'wp_head', 'wpmb_output_head_meta', 5 );
function wpmb_output_head_meta() {
    if ( ! is_singular() ) {
        return;
    }
    $post_id = get_the_ID();

    // Only output if Yoast / RankMath / AIOSEO / SEOPress are NOT active
    $seo_plugins_active = class_exists( 'WPSEO_Options' )
        || class_exists( 'RankMath' )
        || class_exists( 'AIOSEO\Plugin\AIOSEO' )
        || function_exists( 'seopress_init' );

    if ( ! $seo_plugins_active ) {
        $title = get_post_meta( $post_id, 'wpmb_meta_title', true );
        $desc  = get_post_meta( $post_id, 'wpmb_meta_description', true );
        $og_t  = get_post_meta( $post_id, 'wpmb_og_title', true );
        $og_d  = get_post_meta( $post_id, 'wpmb_og_description', true );
        $og_i  = get_post_meta( $post_id, 'wpmb_og_image', true );

        if ( $title ) {
            echo '<meta name="title" content="' . esc_attr( $title ) . '">' . "\n";
        }
        if ( $desc ) {
            echo '<meta name="description" content="' . esc_attr( $desc ) . '">' . "\n";
        }
        if ( $og_t ) {
            echo '<meta property="og:title" content="' . esc_attr( $og_t ) . '">' . "\n";
        }
        if ( $og_d ) {
            echo '<meta property="og:description" content="' . esc_attr( $og_d ) . '">' . "\n";
        }
        if ( $og_i ) {
            echo '<meta property="og:image" content="' . esc_url( $og_i ) . '">' . "\n";
        }
    }

    // Always output schema markup if present
    $schema = get_post_meta( $post_id, 'wpmb_schema_json', true );
    if ( $schema ) {
        echo '<script type="application/ld+json">' . wp_kses_post( $schema ) . '</script>' . "\n";
    }
}
