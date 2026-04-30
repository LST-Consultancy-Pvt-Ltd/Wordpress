<?php
defined( 'ABSPATH' ) || exit;

/**
 * WPMB_Robots — robots.txt read/write endpoints.
 */
class WPMB_Robots {

    private static function robots_path(): string {
        return ABSPATH . 'robots.txt';
    }

    public static function register_routes() {
        $ns = WPMB_NAMESPACE;
        $ep = [ 'WPMB_Auth', 'require_editor' ];

        register_rest_route( $ns, '/robots', [
            [
                'methods'             => 'GET',
                'callback'            => [ __CLASS__, 'get_robots' ],
                'permission_callback' => $ep,
            ],
            [
                'methods'             => 'PUT',
                'callback'            => [ __CLASS__, 'update_robots' ],
                'permission_callback' => $ep,
            ],
        ] );
    }

    public static function get_robots(): WP_REST_Response {
        $path    = self::robots_path();
        $content = '';
        $source  = 'wp_generated';

        if ( file_exists( $path ) ) {
            $content = file_get_contents( $path );
            $source  = 'file';
        } else {
            // WordPress generates robots.txt dynamically
            // Capture output
            ob_start();
            do_action( 'do_robots' );
            $content = ob_get_clean();
        }

        return new WP_REST_Response( [
            'content' => $content,
            'source'  => $source,
            'path'    => $path,
            'writable'=> is_writable( ABSPATH ),
        ], 200 );
    }

    public static function update_robots( WP_REST_Request $request ): WP_REST_Response {
        $content = $request->get_param( 'content' );

        if ( $content === null ) {
            return new WP_REST_Response( [ 'error' => 'content is required' ], 400 );
        }

        $path = self::robots_path();

        if ( ! is_writable( ABSPATH ) ) {
            return new WP_REST_Response( [ 'error' => 'ABSPATH is not writable. Please update robots.txt via FTP or server file manager.' ], 403 );
        }

        $written = file_put_contents( $path, wp_kses_post( $content ) );

        if ( $written === false ) {
            return new WP_REST_Response( [ 'error' => 'Failed to write robots.txt' ], 500 );
        }

        return new WP_REST_Response( [
            'success' => true,
            'path'    => $path,
            'bytes'   => $written,
        ], 200 );
    }
}
