<?php
defined( 'ABSPATH' ) || exit;

/**
 * WPMB_Users — WordPress user management endpoints.
 */
class WPMB_Users {

    public static function register_routes() {
        $ns = WPMB_NAMESPACE;
        $ep = [ 'WPMB_Auth', 'require_editor' ];
        $ap = [ 'WPMB_Auth', 'require_admin' ];

        register_rest_route( $ns, '/wp-users', [
            [
                'methods'             => 'GET',
                'callback'            => [ __CLASS__, 'get_users' ],
                'permission_callback' => $ep,
            ],
            [
                'methods'             => 'POST',
                'callback'            => [ __CLASS__, 'create_user' ],
                'permission_callback' => $ap,
            ],
        ] );

        register_rest_route( $ns, '/wp-users/(?P<user_id>\d+)', [
            [
                'methods'             => 'PUT',
                'callback'            => [ __CLASS__, 'update_user' ],
                'permission_callback' => $ap,
            ],
            [
                'methods'             => 'DELETE',
                'callback'            => [ __CLASS__, 'delete_user' ],
                'permission_callback' => $ap,
            ],
        ] );

        register_rest_route( $ns, '/wp-users/reset-password/(?P<user_id>\d+)', [
            'methods'             => 'POST',
            'callback'            => [ __CLASS__, 'reset_password' ],
            'permission_callback' => $ap,
        ] );
    }

    public static function get_users(): WP_REST_Response {
        $users = get_users( [ 'number' => 100 ] );

        $result = array_map( function( $u ) {
            return [
                'id'           => $u->ID,
                'login'        => $u->user_login,
                'email'        => $u->user_email,
                'display_name' => $u->display_name,
                'first_name'   => $u->first_name,
                'last_name'    => $u->last_name,
                'roles'        => $u->roles,
                'registered'   => $u->user_registered,
                'avatar'       => get_avatar_url( $u->ID, [ 'size' => 48 ] ),
            ];
        }, $users );

        return new WP_REST_Response( $result, 200 );
    }

    public static function create_user( WP_REST_Request $request ): WP_REST_Response {
        $login = sanitize_user( $request->get_param( 'user_login' ) ?? '' );
        $email = sanitize_email( $request->get_param( 'user_email' ) ?? '' );
        $pass  = $request->get_param( 'user_pass' ) ?? wp_generate_password( 16 );
        $role  = sanitize_key( $request->get_param( 'role' ) ?? 'subscriber' );
        $fname = sanitize_text_field( $request->get_param( 'first_name' ) ?? '' );
        $lname = sanitize_text_field( $request->get_param( 'last_name' ) ?? '' );

        if ( ! $login || ! $email ) {
            return new WP_REST_Response( [ 'error' => 'user_login and user_email required' ], 400 );
        }

        $user_id = wp_insert_user( [
            'user_login'  => $login,
            'user_email'  => $email,
            'user_pass'   => $pass,
            'role'        => $role,
            'first_name'  => $fname,
            'last_name'   => $lname,
        ] );

        if ( is_wp_error( $user_id ) ) {
            return new WP_REST_Response( [ 'error' => $user_id->get_error_message() ], 400 );
        }

        wp_new_user_notification( $user_id, null, 'user' );

        return new WP_REST_Response( [
            'success' => true,
            'id'      => $user_id,
            'login'   => $login,
            'email'   => $email,
        ], 201 );
    }

    public static function update_user( WP_REST_Request $request ): WP_REST_Response {
        $user_id = (int) $request['user_id'];
        $data    = [
            'ID' => $user_id,
        ];

        if ( $request->get_param( 'user_email' ) ) {
            $data['user_email'] = sanitize_email( $request->get_param( 'user_email' ) );
        }
        if ( $request->get_param( 'display_name' ) ) {
            $data['display_name'] = sanitize_text_field( $request->get_param( 'display_name' ) );
        }
        if ( $request->get_param( 'first_name' ) ) {
            $data['first_name'] = sanitize_text_field( $request->get_param( 'first_name' ) );
        }
        if ( $request->get_param( 'last_name' ) ) {
            $data['last_name'] = sanitize_text_field( $request->get_param( 'last_name' ) );
        }
        if ( $request->get_param( 'role' ) ) {
            $user = new WP_User( $user_id );
            $user->set_role( sanitize_key( $request->get_param( 'role' ) ) );
        }

        $result = wp_update_user( $data );

        if ( is_wp_error( $result ) ) {
            return new WP_REST_Response( [ 'error' => $result->get_error_message() ], 400 );
        }

        return new WP_REST_Response( [ 'success' => true, 'id' => $user_id ], 200 );
    }

    public static function delete_user( WP_REST_Request $request ): WP_REST_Response {
        $user_id  = (int) $request['user_id'];
        $reassign = (int) ( $request->get_param( 'reassign' ) ?? 1 );

        require_once ABSPATH . 'wp-admin/includes/user.php';

        // Don't allow deleting yourself
        if ( $user_id === get_current_user_id() ) {
            return new WP_REST_Response( [ 'error' => 'Cannot delete your own account' ], 403 );
        }

        $result = wp_delete_user( $user_id, $reassign ?: null );

        if ( ! $result ) {
            return new WP_REST_Response( [ 'error' => 'Failed to delete user' ], 400 );
        }

        return new WP_REST_Response( [ 'success' => true, 'id' => $user_id ], 200 );
    }

    public static function reset_password( WP_REST_Request $request ): WP_REST_Response {
        $user_id = (int) $request['user_id'];
        $user    = get_userdata( $user_id );

        if ( ! $user ) {
            return new WP_REST_Response( [ 'error' => 'User not found' ], 404 );
        }

        $new_pass = wp_generate_password( 16, true, false );
        wp_set_password( $new_pass, $user_id );

        // Send notification email
        wp_mail(
            $user->user_email,
            sprintf( __( '[%s] Password Reset' ), get_bloginfo( 'name' ) ),
            sprintf(
                "Your password has been reset.\n\nNew password: %s\n\nYou can log in at: %s",
                $new_pass,
                wp_login_url()
            )
        );

        return new WP_REST_Response( [
            'success'  => true,
            'id'       => $user_id,
            'email'    => $user->user_email,
            'message'  => 'Password reset email sent',
        ], 200 );
    }
}
