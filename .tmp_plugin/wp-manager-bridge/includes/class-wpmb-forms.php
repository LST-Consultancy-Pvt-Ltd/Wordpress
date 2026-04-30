<?php
defined( 'ABSPATH' ) || exit;

/**
 * WPMB_Forms — Forms & Leads endpoints.
 *
 * Supports Contact Form 7 and WPForms.
 */
class WPMB_Forms {

    public static function register_routes() {
        $ns = WPMB_NAMESPACE;
        $ep = [ 'WPMB_Auth', 'require_editor' ];

        register_rest_route( $ns, '/forms', [
            'methods'             => 'GET',
            'callback'            => [ __CLASS__, 'get_forms' ],
            'permission_callback' => $ep,
        ] );

        register_rest_route( $ns, '/forms/(?P<form_id>\d+)/entries', [
            'methods'             => 'GET',
            'callback'            => [ __CLASS__, 'get_entries' ],
            'permission_callback' => $ep,
        ] );

        register_rest_route( $ns, '/forms/ai-analyze/(?P<form_id>\d+)', [
            'methods'             => 'POST',
            'callback'            => [ __CLASS__, 'analyze' ],
            'permission_callback' => $ep,
        ] );

        register_rest_route( $ns, '/forms/create-faq-post/(?P<form_id>\d+)', [
            'methods'             => 'POST',
            'callback'            => [ __CLASS__, 'create_faq_post' ],
            'permission_callback' => $ep,
        ] );
    }

    public static function get_forms(): WP_REST_Response {
        $forms  = [];

        // Contact Form 7
        if ( function_exists( 'wpcf7_contact_form' ) ) {
            $cf7_forms = get_posts( [
                'post_type'      => 'wpcf7_contact_form',
                'posts_per_page' => 50,
                'post_status'    => 'publish',
            ] );
            foreach ( $cf7_forms as $f ) {
                $forms[] = [ 'id' => $f->ID, 'title' => $f->post_title, 'plugin' => 'cf7' ];
            }
        }

        // WPForms
        if ( function_exists( 'wpforms' ) ) {
            $wpf_forms = get_posts( [
                'post_type'      => 'wpforms',
                'posts_per_page' => 50,
                'post_status'    => 'publish',
            ] );
            foreach ( $wpf_forms as $f ) {
                $forms[] = [ 'id' => $f->ID, 'title' => $f->post_title, 'plugin' => 'wpforms' ];
            }
        }

        // Gravity Forms
        if ( class_exists( 'GFAPI' ) ) {
            $gf_forms = GFAPI::get_forms();
            foreach ( $gf_forms as $f ) {
                $forms[] = [ 'id' => $f['id'], 'title' => $f['title'], 'plugin' => 'gravity' ];
            }
        }

        return new WP_REST_Response( $forms, 200 );
    }

    public static function get_entries( WP_REST_Request $request ): WP_REST_Response {
        $form_id = (int) $request['form_id'];
        $entries = [];

        // WPForms entries
        if ( function_exists( 'wpforms' ) && class_exists( '\WPForms\Pro\Forms\Fields\Base\Frontend' ) ) {
            // WPForms Pro stores entries in custom table
            global $wpdb;
            $table = $wpdb->prefix . 'wpforms_entries';
            if ( $wpdb->get_var( "SHOW TABLES LIKE '$table'" ) === $table ) {
                $rows = $wpdb->get_results( $wpdb->prepare(
                    "SELECT * FROM $table WHERE form_id = %d ORDER BY date DESC LIMIT 100",
                    $form_id
                ), ARRAY_A );
                foreach ( $rows as $row ) {
                    $entries[] = [
                        'id'      => $row['entry_id'],
                        'form_id' => $form_id,
                        'data'    => json_decode( $row['fields'] ?? '{}', true ),
                        'date'    => $row['date'],
                        'plugin'  => 'wpforms',
                    ];
                }
            }
        }

        // Gravity Forms entries
        if ( class_exists( 'GFAPI' ) ) {
            $gf_entries = GFAPI::get_entries( $form_id, [], null, [ 'page_size' => 100 ] );
            if ( ! is_wp_error( $gf_entries ) ) {
                foreach ( $gf_entries as $e ) {
                    $entries[] = [ 'id' => $e['id'], 'form_id' => $form_id, 'data' => $e, 'date' => $e['date_created'], 'plugin' => 'gravity' ];
                }
            }
        }

        return new WP_REST_Response( $entries, 200 );
    }

    public static function analyze( WP_REST_Request $request ): WP_REST_Response {
        $form_id = (int) $request['form_id'];

        // Return entries for backend AI analysis
        $entries_response = self::get_entries( $request );
        $entries          = $entries_response->get_data();

        return new WP_REST_Response( [
            'form_id'       => $form_id,
            'entry_count'   => count( $entries ),
            'entries'       => array_slice( $entries, 0, 50 ), // sample
            'message'       => 'Entries returned for AI analysis. Backend should analyze patterns and return insights.',
        ], 200 );
    }

    public static function create_faq_post( WP_REST_Request $request ): WP_REST_Response {
        $form_id     = (int) $request['form_id'];
        $title       = sanitize_text_field( $request->get_param( 'title' ) ?? "FAQ from Form #{$form_id}" );
        $content     = wp_kses_post( $request->get_param( 'content' ) ?? '' );

        if ( ! $content ) {
            return new WP_REST_Response( [ 'error' => 'content is required (provide AI-generated FAQ content)' ], 400 );
        }

        $post_id = wp_insert_post( [
            'post_title'   => $title,
            'post_content' => $content,
            'post_status'  => 'draft',
            'post_type'    => 'post',
        ] );

        if ( is_wp_error( $post_id ) ) {
            return new WP_REST_Response( [ 'error' => $post_id->get_error_message() ], 400 );
        }

        return new WP_REST_Response( [
            'success' => true,
            'post_id' => $post_id,
            'url'     => get_permalink( $post_id ),
        ], 201 );
    }
}
