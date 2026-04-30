<?php
defined( 'ABSPATH' ) || exit;

/**
 * WPMB_Comments — Comment management endpoints.
 *
 * The standard WP REST API (wp/v2/comments) handles basic CRUD.
 * These endpoints add: bulk-action, AI-reply stub, post-reply, auto-moderate.
 */
class WPMB_Comments {

    public static function register_routes() {
        $ns = WPMB_NAMESPACE;
        $ep = [ 'WPMB_Auth', 'require_editor' ];

        register_rest_route( $ns, '/comments', [
            'methods'             => 'GET',
            'callback'            => [ __CLASS__, 'get_comments' ],
            'permission_callback' => $ep,
        ] );

        register_rest_route( $ns, '/comments/approve/(?P<comment_id>\d+)', [
            'methods'             => 'POST',
            'callback'            => [ __CLASS__, 'approve' ],
            'permission_callback' => $ep,
        ] );

        register_rest_route( $ns, '/comments/spam/(?P<comment_id>\d+)', [
            'methods'             => 'POST',
            'callback'            => [ __CLASS__, 'mark_spam' ],
            'permission_callback' => $ep,
        ] );

        register_rest_route( $ns, '/comments/(?P<comment_id>\d+)', [
            'methods'             => 'DELETE',
            'callback'            => [ __CLASS__, 'delete_comment' ],
            'permission_callback' => $ep,
        ] );

        register_rest_route( $ns, '/comments/bulk-action', [
            'methods'             => 'POST',
            'callback'            => [ __CLASS__, 'bulk_action' ],
            'permission_callback' => $ep,
        ] );

        // AI reply — returns comment text so backend can generate; or accepts AI reply directly
        register_rest_route( $ns, '/comments/ai-reply/(?P<comment_id>\d+)', [
            'methods'             => 'POST',
            'callback'            => [ __CLASS__, 'ai_reply' ],
            'permission_callback' => $ep,
        ] );

        // Post a composed reply
        register_rest_route( $ns, '/comments/post-reply/(?P<comment_id>\d+)', [
            'methods'             => 'POST',
            'callback'            => [ __CLASS__, 'post_reply' ],
            'permission_callback' => $ep,
        ] );

        // Auto-moderate: approve legit, spam obvious
        register_rest_route( $ns, '/comments/auto-moderate', [
            'methods'             => 'POST',
            'callback'            => [ __CLASS__, 'auto_moderate' ],
            'permission_callback' => $ep,
        ] );
    }

    public static function get_comments( WP_REST_Request $request ): WP_REST_Response {
        $status = sanitize_text_field( $request->get_param( 'status' ) ?? 'hold' );

        $comments = get_comments( [
            'status'  => $status,
            'number'  => 100,
            'orderby' => 'comment_date',
            'order'   => 'DESC',
        ] );

        $result = array_map( function( $c ) {
            return [
                'id'         => (int) $c->comment_ID,
                'post_id'    => (int) $c->comment_post_ID,
                'author'     => $c->comment_author,
                'email'      => $c->comment_author_email,
                'content'    => $c->comment_content,
                'date'       => $c->comment_date,
                'status'     => $c->comment_approved,
                'parent'     => (int) $c->comment_parent,
            ];
        }, $comments );

        return new WP_REST_Response( $result, 200 );
    }

    public static function approve( WP_REST_Request $request ): WP_REST_Response {
        $id = (int) $request['comment_id'];
        wp_set_comment_status( $id, 'approve' );
        return new WP_REST_Response( [ 'success' => true, 'id' => $id ], 200 );
    }

    public static function mark_spam( WP_REST_Request $request ): WP_REST_Response {
        $id = (int) $request['comment_id'];
        wp_spam_comment( $id );
        return new WP_REST_Response( [ 'success' => true, 'id' => $id ], 200 );
    }

    public static function delete_comment( WP_REST_Request $request ): WP_REST_Response {
        $id = (int) $request['comment_id'];
        wp_delete_comment( $id, true );
        return new WP_REST_Response( [ 'success' => true, 'id' => $id ], 200 );
    }

    public static function bulk_action( WP_REST_Request $request ): WP_REST_Response {
        $action      = sanitize_key( $request->get_param( 'action' ) ?? '' );
        $comment_ids = array_map( 'intval', (array) ( $request->get_param( 'comment_ids' ) ?? [] ) );
        $results     = [];

        foreach ( $comment_ids as $id ) {
            switch ( $action ) {
                case 'approve':
                    wp_set_comment_status( $id, 'approve' );
                    $results[] = [ 'id' => $id, 'action' => 'approved' ];
                    break;
                case 'spam':
                    wp_spam_comment( $id );
                    $results[] = [ 'id' => $id, 'action' => 'spammed' ];
                    break;
                case 'delete':
                    wp_delete_comment( $id, true );
                    $results[] = [ 'id' => $id, 'action' => 'deleted' ];
                    break;
                case 'trash':
                    wp_trash_comment( $id );
                    $results[] = [ 'id' => $id, 'action' => 'trashed' ];
                    break;
            }
        }

        return new WP_REST_Response( [ 'success' => true, 'results' => $results ], 200 );
    }

    public static function ai_reply( WP_REST_Request $request ): WP_REST_Response {
        $id      = (int) $request['comment_id'];
        $comment = get_comment( $id );
        if ( ! $comment ) {
            return new WP_REST_Response( [ 'error' => 'Comment not found' ], 404 );
        }
        // Return raw comment so backend can generate AI reply
        return new WP_REST_Response( [
            'id'        => $id,
            'post_id'   => (int) $comment->comment_post_ID,
            'author'    => $comment->comment_author,
            'content'   => $comment->comment_content,
            'post_title'=> get_the_title( (int) $comment->comment_post_ID ),
        ], 200 );
    }

    public static function post_reply( WP_REST_Request $request ): WP_REST_Response {
        $parent_id = (int) $request['comment_id'];
        $parent    = get_comment( $parent_id );
        $reply     = sanitize_textarea_field( $request->get_param( 'reply' ) ?? '' );

        if ( ! $parent || ! $reply ) {
            return new WP_REST_Response( [ 'error' => 'Parent comment and reply are required' ], 400 );
        }

        $new_id = wp_insert_comment( [
            'comment_post_ID'  => $parent->comment_post_ID,
            'comment_content'  => $reply,
            'comment_parent'   => $parent_id,
            'comment_approved' => 1,
            'user_id'          => get_current_user_id(),
            'comment_author'   => wp_get_current_user()->display_name,
            'comment_author_email' => wp_get_current_user()->user_email,
        ] );

        return new WP_REST_Response( [ 'success' => true, 'new_comment_id' => $new_id ], 201 );
    }

    public static function auto_moderate(): WP_REST_Response {
        $pending = get_comments( [ 'status' => 'hold', 'number' => 100 ] );
        $approved = 0;
        $spammed  = 0;

        foreach ( $pending as $c ) {
            // Simple heuristic: short comments with links → spam; others → approve
            $link_count = substr_count( $c->comment_content, 'http' );
            $word_count = str_word_count( $c->comment_content );

            if ( $link_count > 2 || $word_count < 3 ) {
                wp_spam_comment( $c->comment_ID );
                $spammed++;
            } else {
                wp_set_comment_status( $c->comment_ID, 'approve' );
                $approved++;
            }
        }

        return new WP_REST_Response( [
            'success'  => true,
            'approved' => $approved,
            'spammed'  => $spammed,
        ], 200 );
    }
}
