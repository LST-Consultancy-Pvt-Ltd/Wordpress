<?php
/**
 * Plugin Name:       WP Manager Bridge
 * Plugin URI:        https://github.com/your-org/wp-manager-bridge
 * Description:       Bridge plugin that enables the WP Manager App to push, pull, and write to this WordPress site. Provides Application Password support, CORS headers, extended REST endpoints for SEO, media, comments, redirects, backups, A/B tests, schema markup, robots.txt, sitemaps, WooCommerce, plugin/theme management, and more.
 * Version:           2.0.0
 * Requires at least: 5.6
 * Requires PHP:      7.4
 * Author:            WP Manager App
 * License:           GPL-2.0-or-later
 * Text Domain:       wp-manager-bridge
 */

defined( 'ABSPATH' ) || exit;

define( 'WPMB_VERSION', '2.0.0' );
define( 'WPMB_PLUGIN_DIR', plugin_dir_path( __FILE__ ) );
define( 'WPMB_NAMESPACE', 'wp-manager/v1' );

/* =========================================================
 *  AUTOLOAD MODULES
 * ======================================================= */
$modules = [
    'class-wpmb-cors.php',
    'class-wpmb-auth.php',
    'class-wpmb-health.php',
    'class-wpmb-seo.php',
    'class-wpmb-media.php',
    'class-wpmb-comments.php',
    'class-wpmb-redirects.php',
    'class-wpmb-backups.php',
    'class-wpmb-ab-tests.php',
    'class-wpmb-schema.php',
    'class-wpmb-sitemap.php',
    'class-wpmb-robots.php',
    'class-wpmb-woocommerce.php',
    'class-wpmb-plugins-themes.php',
    'class-wpmb-forms.php',
    'class-wpmb-navigation.php',
    'class-wpmb-users.php',
];

foreach ( $modules as $module ) {
    $path = WPMB_PLUGIN_DIR . 'includes/' . $module;
    if ( file_exists( $path ) ) {
        require_once $path;
    }
}

/* =========================================================
 *  BOOTSTRAP
 * ======================================================= */
add_action( 'plugins_loaded', 'wpmb_bootstrap' );

function wpmb_bootstrap() {
    // CORS must fire first, before any REST output
    WPMB_CORS::init();
    WPMB_Auth::init();

    add_action( 'rest_api_init', 'wpmb_register_all_routes' );
}

function wpmb_register_all_routes() {
    WPMB_Health::register_routes();
    WPMB_SEO::register_routes();
    WPMB_Media::register_routes();
    WPMB_Comments::register_routes();
    WPMB_Redirects::register_routes();
    WPMB_Backups::register_routes();
    WPMB_AB_Tests::register_routes();
    WPMB_Schema::register_routes();
    WPMB_Sitemap::register_routes();
    WPMB_Robots::register_routes();
    WPMB_Navigation::register_routes();
    WPMB_Users::register_routes();

    if ( class_exists( 'WooCommerce' ) ) {
        WPMB_WooCommerce::register_routes();
    }

    WPMB_Plugins_Themes::register_routes();
    WPMB_Forms::register_routes();
}

/* =========================================================
 *  ACTIVATION / DEACTIVATION
 * ======================================================= */
register_activation_hook( __FILE__, 'wpmb_activate' );
register_deactivation_hook( __FILE__, 'wpmb_deactivate' );

function wpmb_activate() {
    // Ensure Application Passwords are enabled (WP 5.6+)
    if ( ! defined( 'WP_APPLICATION_PASSWORDS_ENABLED' ) ) {
        // Already enabled by default in WP 5.6+
    }

    // Create plugin option defaults
    if ( ! get_option( 'wpmb_settings' ) ) {
        update_option( 'wpmb_settings', [
            'allowed_origins' => [],
            'enable_logging'  => false,
        ] );
    }

    // Create AB test table
    global $wpdb;
    $charset_collate = $wpdb->get_charset_collate();
    $table_ab = $wpdb->prefix . 'wpmb_ab_tests';

    $sql = "CREATE TABLE IF NOT EXISTS $table_ab (
        id BIGINT(20) UNSIGNED NOT NULL AUTO_INCREMENT,
        post_id BIGINT(20) UNSIGNED NOT NULL,
        variant_a LONGTEXT NOT NULL,
        variant_b LONGTEXT NOT NULL,
        impressions_a INT(11) DEFAULT 0,
        clicks_a INT(11) DEFAULT 0,
        impressions_b INT(11) DEFAULT 0,
        clicks_b INT(11) DEFAULT 0,
        status VARCHAR(20) DEFAULT 'running',
        winner VARCHAR(2) DEFAULT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY  (id),
        KEY post_id (post_id)
    ) $charset_collate;";

    require_once ABSPATH . 'wp-admin/includes/upgrade.php';
    dbDelta( $sql );

    // Schema records table
    $table_schema = $wpdb->prefix . 'wpmb_schema_records';
    $sql2 = "CREATE TABLE IF NOT EXISTS $table_schema (
        id BIGINT(20) UNSIGNED NOT NULL AUTO_INCREMENT,
        post_id BIGINT(20) UNSIGNED NOT NULL,
        schema_type VARCHAR(100),
        schema_json LONGTEXT NOT NULL,
        applied TINYINT(1) DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY  (id),
        KEY post_id (post_id)
    ) $charset_collate;";
    dbDelta( $sql2 );

    flush_rewrite_rules();
}

function wpmb_deactivate() {
    flush_rewrite_rules();
}
