<?php
defined( 'ABSPATH' ) || exit;

/**
 * WPMB_Schema — JSON-LD Schema Markup management.
 */
class WPMB_Schema {

    private static function table(): string {
        global $wpdb;
        return $wpdb->prefix . 'wpmb_schema_records';
    }

    public static function register_routes() {
        $ns = WPMB_NAMESPACE;
        $ep = [ 'WPMB_Auth', 'require_editor' ];

        register_rest_route( $ns, '/schema', [
            'methods'             => 'GET',
            'callback'            => [ __CLASS__, 'list_schemas' ],
            'permission_callback' => $ep,
        ] );

        register_rest_route( $ns, '/schema/generate', [
            'methods'             => 'POST',
            'callback'            => [ __CLASS__, 'generate_schema' ],
            'permission_callback' => $ep,
        ] );

        register_rest_route( $ns, '/schema/apply/(?P<schema_id>\d+)', [
            'methods'             => 'POST',
            'callback'            => [ __CLASS__, 'apply_schema' ],
            'permission_callback' => $ep,
        ] );

        register_rest_route( $ns, '/schema/(?P<schema_id>\d+)', [
            'methods'             => 'DELETE',
            'callback'            => [ __CLASS__, 'delete_schema' ],
            'permission_callback' => $ep,
        ] );
    }

    public static function list_schemas(): WP_REST_Response {
        global $wpdb;
        $rows = $wpdb->get_results( "SELECT * FROM " . self::table() . " ORDER BY created_at DESC", ARRAY_A );
        return new WP_REST_Response( $rows ?: [], 200 );
    }

    public static function generate_schema( WP_REST_Request $request ): WP_REST_Response {
        global $wpdb;

        $post_id     = (int) $request->get_param( 'post_id' );
        $schema_type = sanitize_text_field( $request->get_param( 'schema_type' ) ?? 'Article' );
        $schema_data = $request->get_param( 'schema' );

        if ( ! $post_id ) {
            return new WP_REST_Response( [ 'error' => 'post_id required' ], 400 );
        }

        $post = get_post( $post_id );
        if ( ! $post ) {
            return new WP_REST_Response( [ 'error' => 'Post not found' ], 404 );
        }

        // If schema_data not provided, generate a sensible default
        if ( ! $schema_data ) {
            $schema_data = self::default_schema( $post, $schema_type );
        }

        $schema_json = is_array( $schema_data ) ? wp_json_encode( $schema_data ) : (string) $schema_data;

        $wpdb->insert( self::table(), [
            'post_id'     => $post_id,
            'schema_type' => $schema_type,
            'schema_json' => $schema_json,
            'applied'     => 0,
        ] );

        $id = $wpdb->insert_id;

        return new WP_REST_Response( [
            'success'     => true,
            'id'          => $id,
            'schema_type' => $schema_type,
            'schema_json' => $schema_json,
        ], 201 );
    }

    public static function apply_schema( WP_REST_Request $request ): WP_REST_Response {
        global $wpdb;

        $schema_id = (int) $request['schema_id'];
        $row       = $wpdb->get_row( $wpdb->prepare( "SELECT * FROM " . self::table() . " WHERE id = %d", $schema_id ), ARRAY_A );

        if ( ! $row ) {
            return new WP_REST_Response( [ 'error' => 'Schema record not found' ], 404 );
        }

        update_post_meta( (int) $row['post_id'], 'wpmb_schema_json', $row['schema_json'] );
        $wpdb->update( self::table(), [ 'applied' => 1 ], [ 'id' => $schema_id ] );

        return new WP_REST_Response( [ 'success' => true, 'post_id' => $row['post_id'] ], 200 );
    }

    public static function delete_schema( WP_REST_Request $request ): WP_REST_Response {
        global $wpdb;
        $schema_id = (int) $request['schema_id'];
        $wpdb->delete( self::table(), [ 'id' => $schema_id ] );
        return new WP_REST_Response( [ 'success' => true ], 200 );
    }

    private static function default_schema( WP_Post $post, string $type ): array {
        $author = get_userdata( $post->post_author );
        $base   = [
            '@context' => 'https://schema.org',
            '@type'    => $type,
            'name'     => $post->post_title,
            'url'      => get_permalink( $post->ID ),
            'datePublished' => $post->post_date,
            'dateModified'  => $post->post_modified,
        ];

        if ( $author ) {
            $base['author'] = [ '@type' => 'Person', 'name' => $author->display_name ];
        }

        $thumbnail_id = get_post_thumbnail_id( $post->ID );
        if ( $thumbnail_id ) {
            $img = wp_get_attachment_image_src( $thumbnail_id, 'full' );
            if ( $img ) {
                $base['image'] = $img[0];
            }
        }

        if ( $type === 'Article' || $type === 'BlogPosting' ) {
            $base['description']  = get_the_excerpt( $post );
            $base['publisher']    = [ '@type' => 'Organization', 'name' => get_bloginfo( 'name' ), 'url' => home_url() ];
        }

        return $base;
    }
}
