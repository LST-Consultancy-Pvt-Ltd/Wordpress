<?php
defined( 'ABSPATH' ) || exit;

/**
 * WPMB_Plugins_Themes — Plugin and theme management endpoints.
 */
class WPMB_Plugins_Themes {

    public static function register_routes() {
        $ns = WPMB_NAMESPACE;
        $ep = [ 'WPMB_Auth', 'require_admin' ];

        register_rest_route( $ns, '/plugins-themes/plugins', [
            'methods'             => 'GET',
            'callback'            => [ __CLASS__, 'get_plugins' ],
            'permission_callback' => $ep,
        ] );

        register_rest_route( $ns, '/plugins-themes/plugins/(?P<slug>.+)/activate', [
            'methods'             => 'POST',
            'callback'            => [ __CLASS__, 'activate_plugin' ],
            'permission_callback' => $ep,
        ] );

        register_rest_route( $ns, '/plugins-themes/plugins/(?P<slug>.+)/deactivate', [
            'methods'             => 'POST',
            'callback'            => [ __CLASS__, 'deactivate_plugin' ],
            'permission_callback' => $ep,
        ] );

        register_rest_route( $ns, '/plugins-themes/themes', [
            'methods'             => 'GET',
            'callback'            => [ __CLASS__, 'get_themes' ],
            'permission_callback' => $ep,
        ] );

        register_rest_route( $ns, '/plugins-themes/themes/(?P<stylesheet>.+)/activate', [
            'methods'             => 'POST',
            'callback'            => [ __CLASS__, 'activate_theme' ],
            'permission_callback' => $ep,
        ] );

        register_rest_route( $ns, '/plugins-themes/security-scan', [
            'methods'             => 'POST',
            'callback'            => [ __CLASS__, 'security_scan' ],
            'permission_callback' => $ep,
        ] );
    }

    public static function get_plugins(): WP_REST_Response {
        if ( ! function_exists( 'get_plugins' ) ) {
            require_once ABSPATH . 'wp-admin/includes/plugin.php';
        }

        $all_plugins    = get_plugins();
        $active_plugins = get_option( 'active_plugins', [] );
        $updates        = get_site_transient( 'update_plugins' );
        $result         = [];

        foreach ( $all_plugins as $path => $plugin ) {
            $has_update = isset( $updates->response[ $path ] );
            $result[]   = [
                'slug'        => dirname( $path ),
                'path'        => $path,
                'name'        => $plugin['Name'],
                'version'     => $plugin['Version'],
                'author'      => $plugin['Author'],
                'description' => $plugin['Description'],
                'active'      => in_array( $path, $active_plugins, true ),
                'has_update'  => $has_update,
                'new_version' => $has_update ? ( $updates->response[ $path ]->new_version ?? '' ) : null,
            ];
        }

        return new WP_REST_Response( $result, 200 );
    }

    public static function activate_plugin( WP_REST_Request $request ): WP_REST_Response {
        if ( ! function_exists( 'activate_plugin' ) ) {
            require_once ABSPATH . 'wp-admin/includes/plugin.php';
        }

        $slug = urldecode( $request['slug'] );

        // Find the plugin path
        $plugin_path = self::find_plugin_path( $slug );
        if ( ! $plugin_path ) {
            return new WP_REST_Response( [ 'error' => "Plugin '$slug' not found" ], 404 );
        }

        $result = activate_plugin( $plugin_path );

        if ( is_wp_error( $result ) ) {
            return new WP_REST_Response( [ 'error' => $result->get_error_message() ], 400 );
        }

        return new WP_REST_Response( [ 'success' => true, 'plugin' => $plugin_path ], 200 );
    }

    public static function deactivate_plugin( WP_REST_Request $request ): WP_REST_Response {
        if ( ! function_exists( 'deactivate_plugins' ) ) {
            require_once ABSPATH . 'wp-admin/includes/plugin.php';
        }

        $slug        = urldecode( $request['slug'] );
        $plugin_path = self::find_plugin_path( $slug );

        if ( ! $plugin_path ) {
            return new WP_REST_Response( [ 'error' => "Plugin '$slug' not found" ], 404 );
        }

        deactivate_plugins( $plugin_path );

        return new WP_REST_Response( [ 'success' => true, 'plugin' => $plugin_path ], 200 );
    }

    public static function get_themes(): WP_REST_Response {
        $themes  = wp_get_themes();
        $current = get_stylesheet();
        $result  = [];

        foreach ( $themes as $stylesheet => $theme ) {
            $result[] = [
                'stylesheet'  => $stylesheet,
                'name'        => $theme->get( 'Name' ),
                'version'     => $theme->get( 'Version' ),
                'author'      => $theme->get( 'Author' ),
                'description' => $theme->get( 'Description' ),
                'active'      => $stylesheet === $current,
                'screenshot'  => $theme->get_screenshot(),
            ];
        }

        return new WP_REST_Response( $result, 200 );
    }

    public static function activate_theme( WP_REST_Request $request ): WP_REST_Response {
        $stylesheet = urldecode( $request['stylesheet'] );

        if ( ! wp_get_theme( $stylesheet )->exists() ) {
            return new WP_REST_Response( [ 'error' => "Theme '$stylesheet' not found" ], 404 );
        }

        switch_theme( $stylesheet );

        return new WP_REST_Response( [ 'success' => true, 'theme' => $stylesheet ], 200 );
    }

    public static function security_scan(): WP_REST_Response {
        if ( ! function_exists( 'get_plugins' ) ) {
            require_once ABSPATH . 'wp-admin/includes/plugin.php';
        }

        $all_plugins    = get_plugins();
        $active_plugins = get_option( 'active_plugins', [] );
        $updates        = get_site_transient( 'update_plugins' );
        $warnings       = [];

        // Check for plugins with known vulnerabilities (basic heuristics)
        $known_vulnerable = [
            'wp-file-manager/file_manager_connector.php' => 'WP File Manager RCE vulnerability',
            'revslider/revslider.php'                    => 'Revolution Slider known XSS vulnerabilities',
        ];

        foreach ( $active_plugins as $plugin ) {
            if ( isset( $known_vulnerable[ $plugin ] ) ) {
                $warnings[] = [ 'plugin' => $plugin, 'reason' => $known_vulnerable[ $plugin ], 'severity' => 'critical' ];
            }
            // Flag outdated active plugins
            if ( isset( $updates->response[ $plugin ] ) ) {
                $warnings[] = [ 'plugin' => $plugin, 'reason' => 'Plugin has an available update — may contain security fixes', 'severity' => 'warning' ];
            }
        }

        // Check WP core version
        global $wp_version;
        $latest = get_site_transient( 'update_core' );
        if ( $latest && ! empty( $latest->updates ) ) {
            $latest_version = $latest->updates[0]->version ?? $wp_version;
            if ( version_compare( $wp_version, $latest_version, '<' ) ) {
                $warnings[] = [ 'plugin' => 'WordPress Core', 'reason' => "WordPress $wp_version is outdated. Latest: $latest_version", 'severity' => 'warning' ];
            }
        }

        return new WP_REST_Response( [
            'total_active'   => count( $active_plugins ),
            'warnings'       => $warnings,
            'warning_count'  => count( $warnings ),
            'wp_version'     => $wp_version,
            'scanned_at'     => current_time( 'mysql' ),
        ], 200 );
    }

    private static function find_plugin_path( string $slug ): ?string {
        if ( ! function_exists( 'get_plugins' ) ) {
            require_once ABSPATH . 'wp-admin/includes/plugin.php';
        }

        $all = get_plugins();

        // Exact match first
        if ( isset( $all[ $slug ] ) ) {
            return $slug;
        }

        // Search by slug (folder name)
        foreach ( array_keys( $all ) as $path ) {
            if ( dirname( $path ) === $slug || $path === $slug ) {
                return $path;
            }
        }

        return null;
    }
}
