<?php
defined( 'ABSPATH' ) || exit;

/**
 * WPMB_Auth — Shared permission callbacks and Application Password helpers.
 *
 * The WP Manager backend authenticates via:
 *   - HTTP Basic Auth with Application Password (default)
 *   - Bearer JWT token (optional — requires separate JWT plugin)
 *
 * WordPress core already handles Application Password authentication on
 * every REST request via `WP_Application_Passwords`. This class just
 * provides the permission callbacks used by all route registrations.
 */
class WPMB_Auth {

    public static function init() {
        // Ensure Application Passwords are enabled on non-SSL local dev
        add_filter( 'wp_is_application_passwords_available', '__return_true' );

        // Allow Application Passwords for all REST requests (not just HTTPS in local dev)
        add_filter( 'application_password_is_api_request', '__return_true' );

        // CDN-resistant auth: accept credentials via X-WPMB-Auth header
        // (Hostinger/Cloudflare/etc. often strip the standard Authorization header)
        add_filter( 'determine_current_user', [ __CLASS__, 'authenticate_via_alt_header' ], 30 );
    }

    /**
     * Authenticate using a custom X-WPMB-Auth header that survives CDN stripping.
     * Format: "Basic base64(username:app_password)"
     * Only kicks in when WordPress hasn't already authenticated the user.
     */
    public static function authenticate_via_alt_header( $user_id ) {
        if ( $user_id ) {
            return $user_id; // Already authenticated by core
        }

        $auth_header = '';
        if ( isset( $_SERVER['HTTP_X_WPMB_AUTH'] ) ) {
            $auth_header = $_SERVER['HTTP_X_WPMB_AUTH'];
        } elseif ( function_exists( 'getallheaders' ) ) {
            $headers = getallheaders();
            foreach ( $headers as $k => $v ) {
                if ( strcasecmp( $k, 'X-WPMB-Auth' ) === 0 ) {
                    $auth_header = $v;
                    break;
                }
            }
        }

        if ( ! $auth_header || stripos( $auth_header, 'Basic ' ) !== 0 ) {
            return $user_id;
        }

        $b64 = trim( substr( $auth_header, 6 ) );
        $decoded = base64_decode( $b64, true );
        if ( ! $decoded || strpos( $decoded, ':' ) === false ) {
            return $user_id;
        }

        list( $username, $password ) = explode( ':', $decoded, 2 );
        $username = trim( $username );
        $password = trim( $password );

        if ( ! $username || ! $password ) {
            return $user_id;
        }

        $user = get_user_by( 'login', $username );
        if ( ! $user ) {
            $user = get_user_by( 'email', $username );
        }
        if ( ! $user ) {
            return $user_id;
        }

        // Try Application Password authentication (recommended)
        if ( class_exists( 'WP_Application_Passwords' ) ) {
            $hashed_passwords = WP_Application_Passwords::get_user_application_passwords( $user->ID );
            if ( is_array( $hashed_passwords ) ) {
                foreach ( $hashed_passwords as $hashed_password ) {
                    foreach ( [ $password, str_replace( ' ', '', $password ) ] as $candidate ) {
                        if ( wp_check_password( $candidate, $hashed_password['password'], $user->ID ) ) {
                            return $user->ID;
                        }
                    }
                }
            }
        }

        // Fallback: regular WP login password
        if ( wp_check_password( $password, $user->user_pass, $user->ID ) ) {
            return $user->ID;
        }

        return $user_id;
    }

    /* -------------------------------------------------------
     *  Permission callbacks
     * ----------------------------------------------------- */

    /**
     * Require at minimum "editor" capabilities.
     * The WP Manager app expects an Editor or Administrator user.
     */
    public static function require_editor( WP_REST_Request $request ): bool|WP_Error {
        if ( ! is_user_logged_in() ) {
            return new WP_Error( 'rest_forbidden', 'Authentication required.', [ 'status' => 401 ] );
        }
        if ( ! current_user_can( 'edit_others_posts' ) ) {
            return new WP_Error( 'rest_forbidden', 'Insufficient permissions. Editor or Administrator role required.', [ 'status' => 403 ] );
        }
        return true;
    }

    /**
     * Require Administrator capabilities.
     */
    public static function require_admin( WP_REST_Request $request ): bool|WP_Error {
        if ( ! is_user_logged_in() ) {
            return new WP_Error( 'rest_forbidden', 'Authentication required.', [ 'status' => 401 ] );
        }
        if ( ! current_user_can( 'manage_options' ) ) {
            return new WP_Error( 'rest_forbidden', 'Administrator role required.', [ 'status' => 403 ] );
        }
        return true;
    }

    /**
     * Public endpoint — no auth required.
     */
    public static function public_permission(): bool {
        return true;
    }
}
