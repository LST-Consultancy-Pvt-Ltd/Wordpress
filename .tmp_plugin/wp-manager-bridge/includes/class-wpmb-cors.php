<?php
defined( 'ABSPATH' ) || exit;

/**
 * WPMB_CORS — Injects CORS headers for all REST API requests from the WP Manager App.
 * Handles OPTIONS preflight automatically.
 */
class WPMB_CORS {

    public static function init() {
        // Fire before WordPress sends any headers
        add_action( 'init', [ __CLASS__, 'handle_preflight' ], 1 );
        add_filter( 'rest_pre_serve_request', [ __CLASS__, 'add_cors_headers' ], 1, 4 );
    }

    /**
     * Respond to OPTIONS preflight immediately (before WP boots fully).
     */
    public static function handle_preflight() {
        if ( 'OPTIONS' !== $_SERVER['REQUEST_METHOD'] ) {
            return;
        }

        $origin = self::get_allowed_origin();
        if ( ! $origin ) {
            return;
        }

        header( 'Access-Control-Allow-Origin: ' . $origin );
        header( 'Access-Control-Allow-Methods: GET, POST, PUT, PATCH, DELETE, OPTIONS' );
        header( 'Access-Control-Allow-Headers: Authorization, Content-Type, X-WP-Nonce, X-Filename, Accept' );
        header( 'Access-Control-Allow-Credentials: true' );
        header( 'Access-Control-Max-Age: 86400' );
        status_header( 204 );
        exit;
    }

    /**
     * Add CORS headers to every REST response.
     */
    public static function add_cors_headers( $served, $result, $request, $server ) {
        $origin = self::get_allowed_origin();
        if ( $origin ) {
            header( 'Access-Control-Allow-Origin: ' . $origin );
            header( 'Access-Control-Allow-Methods: GET, POST, PUT, PATCH, DELETE, OPTIONS' );
            header( 'Access-Control-Allow-Headers: Authorization, Content-Type, X-WP-Nonce, X-Filename, Accept' );
            header( 'Access-Control-Allow-Credentials: true' );
        }
        return $served;
    }

    /**
     * Return the allowed origin or false.
     * Allows any origin in dev; restrict via plugin settings in production.
     */
    private static function get_allowed_origin() {
        $origin  = isset( $_SERVER['HTTP_ORIGIN'] ) ? esc_url_raw( $_SERVER['HTTP_ORIGIN'] ) : '';
        if ( ! $origin ) {
            return false;
        }

        $settings        = get_option( 'wpmb_settings', [] );
        $allowed_origins = $settings['allowed_origins'] ?? [];

        // If no whitelist configured, allow all (open for easy setup)
        if ( empty( $allowed_origins ) ) {
            return $origin;
        }

        foreach ( $allowed_origins as $allowed ) {
            if ( rtrim( $allowed, '/' ) === rtrim( $origin, '/' ) ) {
                return $origin;
            }
        }

        return false;
    }
}
