<?php
defined( 'ABSPATH' ) || exit;

/**
 * WPMB_Health — /wp-json/wp-manager/v1/health
 *
 * Provides site health data, check results, and history.
 * Used by the App's "Site Health" feature.
 */
class WPMB_Health {

    public static function register_routes() {
        $ns = WPMB_NAMESPACE;

        // GET  /wp-manager/v1/health
        register_rest_route( $ns, '/health', [
            'methods'             => 'GET',
            'callback'            => [ __CLASS__, 'get_health' ],
            'permission_callback' => [ 'WPMB_Auth', 'require_editor' ],
        ] );

        // POST /wp-manager/v1/health/check
        register_rest_route( $ns, '/health/check', [
            'methods'             => 'POST',
            'callback'            => [ __CLASS__, 'run_check' ],
            'permission_callback' => [ 'WPMB_Auth', 'require_editor' ],
        ] );

        // GET  /wp-manager/v1/health/history
        register_rest_route( $ns, '/health/history', [
            'methods'             => 'GET',
            'callback'            => [ __CLASS__, 'get_history' ],
            'permission_callback' => [ 'WPMB_Auth', 'require_editor' ],
        ] );

        // POST /wp-manager/v1/ping  (quick connection test)
        register_rest_route( $ns, '/ping', [
            'methods'             => 'GET',
            'callback'            => [ __CLASS__, 'ping' ],
            'permission_callback' => [ 'WPMB_Auth', 'require_editor' ],
        ] );

        // GET /wp-manager/v1/diag (PUBLIC) — diagnostic to see what headers + auth WP receives
        register_rest_route( $ns, '/diag', [
            'methods'             => 'GET',
            'callback'            => [ __CLASS__, 'diag' ],
            'permission_callback' => '__return_true',
        ] );
    }

    public static function diag(): WP_REST_Response {
        $headers_seen = [];
        if ( function_exists( 'getallheaders' ) ) {
            foreach ( getallheaders() as $k => $v ) {
                // Mask credential values for safety
                if ( stripos( $k, 'auth' ) !== false ) {
                    $v = substr( $v, 0, 12 ) . '...(' . strlen( $v ) . ' chars)';
                }
                $headers_seen[ $k ] = $v;
            }
        }
        $server_auth_keys = [];
        foreach ( $_SERVER as $k => $v ) {
            if ( stripos( $k, 'AUTH' ) !== false || stripos( $k, 'WPMB' ) !== false ) {
                $server_auth_keys[ $k ] = is_string( $v ) ? substr( $v, 0, 12 ) . '...' : '<non-string>';
            }
        }
        $current_user = wp_get_current_user();
        return new WP_REST_Response( [
            'plugin_version'   => WPMB_VERSION,
            'is_logged_in'     => is_user_logged_in(),
            'current_user_id'  => $current_user->ID,
            'current_user_login' => $current_user->user_login,
            'current_user_caps' => array_keys( array_filter( $current_user->allcaps ?? [] ) ),
            'has_alt_header_filter' => has_filter( 'determine_current_user', [ 'WPMB_Auth', 'authenticate_via_alt_header' ] ),
            'getallheaders_exists' => function_exists( 'getallheaders' ),
            'headers_received' => $headers_seen,
            'server_auth_vars' => $server_auth_keys,
        ], 200 );
    }

    public static function ping(): WP_REST_Response {
        return new WP_REST_Response( [
            'status'           => 'ok',
            'plugin_version'   => WPMB_VERSION,
            'wp_version'       => get_bloginfo( 'version' ),
            'site_url'         => get_site_url(),
            'rest_url'         => get_rest_url(),
            'user'             => wp_get_current_user()->user_login,
            'app_passwords_ok' => class_exists( 'WP_Application_Passwords' ),
        ], 200 );
    }

    public static function get_health(): WP_REST_Response {
        $data = self::collect_health_data();
        return new WP_REST_Response( $data, 200 );
    }

    public static function run_check(): WP_REST_Response {
        $data = self::collect_health_data();
        // Store snapshot in option (rolling 30)
        $history   = get_option( 'wpmb_health_history', [] );
        $history[] = array_merge( $data, [ 'checked_at' => current_time( 'mysql' ) ] );
        $history   = array_slice( $history, -30 );
        update_option( 'wpmb_health_history', $history );
        return new WP_REST_Response( $data, 200 );
    }

    public static function get_history(): WP_REST_Response {
        $history = get_option( 'wpmb_health_history', [] );
        return new WP_REST_Response( $history, 200 );
    }

    private static function collect_health_data(): array {
        global $wpdb;

        $upload_dir   = wp_upload_dir();
        $disk_free    = function_exists( 'disk_free_space' ) ? disk_free_space( ABSPATH ) : null;
        $disk_total   = function_exists( 'disk_total_space' ) ? disk_total_space( ABSPATH ) : null;

        $issues = [];

        // PHP version check
        if ( version_compare( PHP_VERSION, '7.4', '<' ) ) {
            $issues[] = [ 'key' => 'php_version', 'severity' => 'error', 'message' => 'PHP version is below 7.4' ];
        }

        // WP debug mode
        if ( defined( 'WP_DEBUG' ) && WP_DEBUG ) {
            $issues[] = [ 'key' => 'wp_debug', 'severity' => 'warning', 'message' => 'WP_DEBUG is enabled — disable in production' ];
        }

        // Uploads writable
        if ( ! wp_is_writable( $upload_dir['basedir'] ) ) {
            $issues[] = [ 'key' => 'uploads_writable', 'severity' => 'error', 'message' => 'Uploads directory is not writable' ];
        }

        // Active plugin count
        $active_plugins = get_option( 'active_plugins', [] );
        if ( count( $active_plugins ) > 50 ) {
            $issues[] = [ 'key' => 'plugin_count', 'severity' => 'warning', 'message' => 'More than 50 active plugins detected' ];
        }

        return [
            'status'          => empty( $issues ) ? 'healthy' : 'issues',
            'php_version'     => PHP_VERSION,
            'wp_version'      => get_bloginfo( 'version' ),
            'site_url'        => get_site_url(),
            'memory_limit'    => WP_MEMORY_LIMIT,
            'memory_usage'    => size_format( memory_get_usage( true ) ),
            'max_upload_size' => size_format( wp_max_upload_size() ),
            'disk_free_gb'    => $disk_free ? round( $disk_free / 1073741824, 2 ) : null,
            'disk_total_gb'   => $disk_total ? round( $disk_total / 1073741824, 2 ) : null,
            'active_plugins'  => count( $active_plugins ),
            'is_ssl'          => is_ssl(),
            'permalink_structure' => get_option( 'permalink_structure' ),
            'timezone'        => get_option( 'timezone_string' ),
            'debug_mode'      => defined( 'WP_DEBUG' ) && WP_DEBUG,
            'db_version'      => $wpdb->db_version(),
            'issues'          => $issues,
        ];
    }
}
