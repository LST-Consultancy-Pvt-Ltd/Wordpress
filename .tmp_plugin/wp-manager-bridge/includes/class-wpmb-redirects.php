<?php
defined( 'ABSPATH' ) || exit;

/**
 * WPMB_Redirects — Redirect management.
 *
 * Attempts to use the Redirection plugin (John Godley) if installed.
 * Falls back to a custom DB table if not available.
 */
class WPMB_Redirects {

    public static function register_routes() {
        $ns = WPMB_NAMESPACE;
        $ep = [ 'WPMB_Auth', 'require_editor' ];

        register_rest_route( $ns, '/redirects', [
            [
                'methods'             => 'GET',
                'callback'            => [ __CLASS__, 'list_redirects' ],
                'permission_callback' => $ep,
            ],
            [
                'methods'             => 'POST',
                'callback'            => [ __CLASS__, 'create_redirect' ],
                'permission_callback' => $ep,
            ],
        ] );

        register_rest_route( $ns, '/redirects/(?P<redirect_id>[\w-]+)', [
            'methods'             => 'DELETE',
            'callback'            => [ __CLASS__, 'delete_redirect' ],
            'permission_callback' => $ep,
        ] );

        register_rest_route( $ns, '/redirects/bulk-create', [
            'methods'             => 'POST',
            'callback'            => [ __CLASS__, 'bulk_create' ],
            'permission_callback' => $ep,
        ] );

        register_rest_route( $ns, '/redirects/ai-suggest', [
            'methods'             => 'POST',
            'callback'            => [ __CLASS__, 'ai_suggest' ],
            'permission_callback' => $ep,
        ] );
    }

    public static function list_redirects(): WP_REST_Response {
        // Try Redirection plugin first
        if ( class_exists( 'Red_Item' ) ) {
            $items   = Red_Item::get_all();
            $result  = [];
            foreach ( $items as $item ) {
                $result[] = [
                    'id'          => $item->get_id(),
                    'source'      => $item->get_url(),
                    'target'      => $item->get_action_data(),
                    'type'        => $item->get_action_code(),
                    'enabled'     => $item->is_enabled(),
                    'hits'        => $item->get_hits(),
                ];
            }
            return new WP_REST_Response( $result, 200 );
        }

        // Fallback: custom option store
        $redirects = get_option( 'wpmb_redirects', [] );
        return new WP_REST_Response( array_values( $redirects ), 200 );
    }

    public static function create_redirect( WP_REST_Request $request ): WP_REST_Response {
        $source = sanitize_text_field( $request->get_param( 'source' ) ?? '' );
        $target = esc_url_raw( $request->get_param( 'target' ) ?? '' );
        $code   = (int) ( $request->get_param( 'type' ) ?? 301 );

        if ( ! $source || ! $target ) {
            return new WP_REST_Response( [ 'error' => 'source and target are required' ], 400 );
        }

        if ( class_exists( 'Red_Item' ) ) {
            $result = Red_Item::create( [
                'url'         => $source,
                'action_data' => [ 'url' => $target ],
                'action_type' => 'url',
                'action_code' => $code,
                'match_type'  => 'url',
                'group_id'    => 1,
            ] );

            if ( is_wp_error( $result ) ) {
                return new WP_REST_Response( [ 'error' => $result->get_error_message() ], 400 );
            }

            return new WP_REST_Response( [ 'success' => true, 'id' => $result->get_id() ], 201 );
        }

        // Custom store fallback
        $redirects = get_option( 'wpmb_redirects', [] );
        $id        = uniqid( 'rdr_', true );
        $redirects[ $id ] = compact( 'id', 'source', 'target', 'code' );
        update_option( 'wpmb_redirects', $redirects );

        self::flush_htaccess( $redirects );

        return new WP_REST_Response( [ 'success' => true, 'id' => $id ], 201 );
    }

    public static function delete_redirect( WP_REST_Request $request ): WP_REST_Response {
        $rid = $request['redirect_id'];

        if ( class_exists( 'Red_Item' ) && is_numeric( $rid ) ) {
            $item = Red_Item::get_by_id( (int) $rid );
            if ( $item ) {
                $item->delete();
                return new WP_REST_Response( [ 'success' => true ], 200 );
            }
        }

        $redirects = get_option( 'wpmb_redirects', [] );
        if ( isset( $redirects[ $rid ] ) ) {
            unset( $redirects[ $rid ] );
            update_option( 'wpmb_redirects', $redirects );
            self::flush_htaccess( $redirects );
            return new WP_REST_Response( [ 'success' => true ], 200 );
        }

        return new WP_REST_Response( [ 'error' => 'Redirect not found' ], 404 );
    }

    public static function bulk_create( WP_REST_Request $request ): WP_REST_Response {
        $items   = (array) ( $request->get_param( 'redirects' ) ?? [] );
        $results = [];

        foreach ( $items as $item ) {
            $r = new WP_REST_Request( 'POST' );
            $r->set_param( 'source', $item['source'] ?? '' );
            $r->set_param( 'target', $item['target'] ?? '' );
            $r->set_param( 'type', $item['type'] ?? 301 );
            $res     = self::create_redirect( $r );
            $results[] = $res->get_data();
        }

        return new WP_REST_Response( [ 'success' => true, 'results' => $results ], 201 );
    }

    public static function ai_suggest(): WP_REST_Response {
        // Collect 404 data — look at WP 404 pages recently hit (basic approach)
        // Return list of published pages as potential targets for redirect suggestions
        $pages = get_posts( [
            'post_type'      => [ 'post', 'page' ],
            'post_status'    => 'publish',
            'posts_per_page' => 20,
            'orderby'        => 'date',
            'order'          => 'DESC',
        ] );

        $suggestions = array_map( function( $p ) {
            return [
                'target' => get_permalink( $p->ID ),
                'title'  => $p->post_title,
                'type'   => $p->post_type,
            ];
        }, $pages );

        return new WP_REST_Response( [
            'message'     => 'Provide 404 log data to your backend for AI redirect suggestions. Available targets listed.',
            'targets'     => $suggestions,
        ], 200 );
    }

    // Write custom redirects to .htaccess if Redirection plugin absent
    private static function flush_htaccess( array $redirects ): void {
        if ( ! function_exists( 'insert_with_markers' ) ) {
            require_once ABSPATH . 'wp-admin/includes/misc.php';
        }

        $lines = [];
        foreach ( $redirects as $r ) {
            $lines[] = sprintf(
                'Redirect %d %s %s',
                (int) ( $r['code'] ?? 301 ),
                esc_url_raw( $r['source'] ),
                esc_url_raw( $r['target'] )
            );
        }

        $htaccess = ABSPATH . '.htaccess';
        if ( is_writable( $htaccess ) ) {
            insert_with_markers( $htaccess, 'WP Manager Redirects', $lines );
        }
    }
}
