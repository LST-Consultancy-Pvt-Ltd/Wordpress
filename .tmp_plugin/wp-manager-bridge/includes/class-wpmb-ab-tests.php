<?php
defined( 'ABSPATH' ) || exit;

/**
 * WPMB_AB_Tests — A/B testing for posts (title & content variants).
 */
class WPMB_AB_Tests {

    private static function table(): string {
        global $wpdb;
        return $wpdb->prefix . 'wpmb_ab_tests';
    }

    public static function register_routes() {
        $ns = WPMB_NAMESPACE;
        $ep = [ 'WPMB_Auth', 'require_editor' ];

        register_rest_route( $ns, '/ab', [
            [
                'methods'             => 'GET',
                'callback'            => [ __CLASS__, 'list_tests' ],
                'permission_callback' => $ep,
            ],
        ] );

        register_rest_route( $ns, '/ab/create', [
            'methods'             => 'POST',
            'callback'            => [ __CLASS__, 'create_test' ],
            'permission_callback' => $ep,
        ] );

        register_rest_route( $ns, '/ab/record-impression/(?P<test_id>\d+)', [
            'methods'             => 'POST',
            'callback'            => [ __CLASS__, 'record_impression' ],
            'permission_callback' => [ 'WPMB_Auth', 'public_permission' ],
        ] );

        register_rest_route( $ns, '/ab/record-click/(?P<test_id>\d+)', [
            'methods'             => 'POST',
            'callback'            => [ __CLASS__, 'record_click' ],
            'permission_callback' => [ 'WPMB_Auth', 'public_permission' ],
        ] );

        register_rest_route( $ns, '/ab/switch-variant/(?P<test_id>\d+)', [
            'methods'             => 'POST',
            'callback'            => [ __CLASS__, 'switch_variant' ],
            'permission_callback' => $ep,
        ] );

        register_rest_route( $ns, '/ab/conclude/(?P<test_id>\d+)', [
            'methods'             => 'POST',
            'callback'            => [ __CLASS__, 'conclude_test' ],
            'permission_callback' => $ep,
        ] );

        register_rest_route( $ns, '/ab/ai-generate-variants/(?P<post_id>\d+)', [
            'methods'             => 'POST',
            'callback'            => [ __CLASS__, 'ai_generate_variants' ],
            'permission_callback' => $ep,
        ] );

        // Title A/B tests
        register_rest_route( $ns, '/ab-testing/title-test', [
            'methods'             => 'POST',
            'callback'            => [ __CLASS__, 'create_title_test' ],
            'permission_callback' => $ep,
        ] );

        register_rest_route( $ns, '/ab-testing/title-tests', [
            'methods'             => 'GET',
            'callback'            => [ __CLASS__, 'list_title_tests' ],
            'permission_callback' => $ep,
        ] );

        register_rest_route( $ns, '/ab-testing/title-test/(?P<test_id>\d+)/conclude', [
            'methods'             => 'POST',
            'callback'            => [ __CLASS__, 'conclude_title_test' ],
            'permission_callback' => $ep,
        ] );
    }

    public static function list_tests(): WP_REST_Response {
        global $wpdb;
        $table = self::table();
        $rows  = $wpdb->get_results( "SELECT * FROM $table ORDER BY created_at DESC", ARRAY_A );
        return new WP_REST_Response( $rows ?: [], 200 );
    }

    public static function create_test( WP_REST_Request $request ): WP_REST_Response {
        global $wpdb;
        $post_id   = (int) $request->get_param( 'post_id' );
        $variant_a = sanitize_textarea_field( $request->get_param( 'variant_a' ) ?? '' );
        $variant_b = sanitize_textarea_field( $request->get_param( 'variant_b' ) ?? '' );

        if ( ! $post_id || ! $variant_a || ! $variant_b ) {
            return new WP_REST_Response( [ 'error' => 'post_id, variant_a, variant_b required' ], 400 );
        }

        $wpdb->insert( self::table(), [
            'post_id'   => $post_id,
            'variant_a' => $variant_a,
            'variant_b' => $variant_b,
            'status'    => 'running',
        ] );

        return new WP_REST_Response( [ 'success' => true, 'id' => $wpdb->insert_id ], 201 );
    }

    public static function record_impression( WP_REST_Request $request ): WP_REST_Response {
        global $wpdb;
        $test_id = (int) $request['test_id'];
        $variant = sanitize_key( $request->get_param( 'variant' ) ?? 'a' );
        $col     = $variant === 'b' ? 'impressions_b' : 'impressions_a';
        $wpdb->query( $wpdb->prepare( "UPDATE {$wpdb->prefix}wpmb_ab_tests SET $col = $col + 1 WHERE id = %d", $test_id ) );
        return new WP_REST_Response( [ 'success' => true ], 200 );
    }

    public static function record_click( WP_REST_Request $request ): WP_REST_Response {
        global $wpdb;
        $test_id = (int) $request['test_id'];
        $variant = sanitize_key( $request->get_param( 'variant' ) ?? 'a' );
        $col     = $variant === 'b' ? 'clicks_b' : 'clicks_a';
        $wpdb->query( $wpdb->prepare( "UPDATE {$wpdb->prefix}wpmb_ab_tests SET $col = $col + 1 WHERE id = %d", $test_id ) );
        return new WP_REST_Response( [ 'success' => true ], 200 );
    }

    public static function switch_variant( WP_REST_Request $request ): WP_REST_Response {
        global $wpdb;
        $test_id = (int) $request['test_id'];
        $test    = $wpdb->get_row( $wpdb->prepare( "SELECT * FROM {$wpdb->prefix}wpmb_ab_tests WHERE id = %d", $test_id ), ARRAY_A );
        if ( ! $test ) {
            return new WP_REST_Response( [ 'error' => 'Test not found' ], 404 );
        }
        // Swap current winner/loser — update post title with variant_b
        wp_update_post( [ 'ID' => (int) $test['post_id'], 'post_title' => $test['variant_b'] ] );
        return new WP_REST_Response( [ 'success' => true ], 200 );
    }

    public static function conclude_test( WP_REST_Request $request ): WP_REST_Response {
        global $wpdb;
        $test_id = (int) $request['test_id'];
        $winner  = sanitize_key( $request->get_param( 'winner' ) ?? 'a' );

        $test = $wpdb->get_row( $wpdb->prepare( "SELECT * FROM {$wpdb->prefix}wpmb_ab_tests WHERE id = %d", $test_id ), ARRAY_A );
        if ( ! $test ) {
            return new WP_REST_Response( [ 'error' => 'Test not found' ], 404 );
        }

        // Apply winning variant to the post
        $winning_text = $winner === 'b' ? $test['variant_b'] : $test['variant_a'];
        wp_update_post( [ 'ID' => (int) $test['post_id'], 'post_title' => $winning_text ] );

        $wpdb->update( self::table(), [ 'status' => 'concluded', 'winner' => $winner ], [ 'id' => $test_id ] );

        return new WP_REST_Response( [ 'success' => true, 'winner' => $winner ], 200 );
    }

    public static function ai_generate_variants( WP_REST_Request $request ): WP_REST_Response {
        $post_id = (int) $request['post_id'];
        $post    = get_post( $post_id );
        if ( ! $post ) {
            return new WP_REST_Response( [ 'error' => 'Post not found' ], 404 );
        }
        // Return post content/title so backend AI can generate variants
        return new WP_REST_Response( [
            'post_id'   => $post_id,
            'title'     => $post->post_title,
            'excerpt'   => get_the_excerpt( $post ),
            'url'       => get_permalink( $post_id ),
        ], 200 );
    }

    public static function create_title_test( WP_REST_Request $request ): WP_REST_Response {
        return self::create_test( $request );
    }

    public static function list_title_tests(): WP_REST_Response {
        return self::list_tests();
    }

    public static function conclude_title_test( WP_REST_Request $request ): WP_REST_Response {
        return self::conclude_test( $request );
    }
}
