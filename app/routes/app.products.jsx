import { useLoaderData } from "react-router";
import { authenticate } from "../shopify.server";

export const loader = async ({ request }) => {
    const { admin } = await authenticate.admin(request);

    const response = await admin.graphql(
        `#graphql
    query getProducts {
      products(first: 20) {
        edges {
          node {
            id
            title
            handle
            status
            totalInventory
            featuredImage {
              url
              altText
            }
            variants(first: 1) {
              edges {
                node {
                  price
                }
              }
            }
          }
        }
      }
    }`,
    );

    const responseJson = await response.json();

    return {
        products: responseJson.data.products.edges.map((edge) => edge.node),
    };
};

export default function ProductsPage() {
    const { products } = useLoaderData();

    if (products.length === 0) {
        return (
            <s-page heading="Products">
                <s-empty-state
                    heading="No products found"
                    image="https://cdn.shopify.com/s/files/1/0262/4071/2726/files/emptystate-files.png"
                >
                    <s-paragraph>Add products to your store to see them here.</s-paragraph>
                    <s-button
                        slot="action"
                        href="shopify://admin/products/new"
                        target="_blank"
                    >
                        Add product
                    </s-button>
                </s-empty-state>
            </s-page>
        );
    }

    return (
        <s-page heading="Products">
            <s-card padding="0">
                <s-data-table>
                    <table style={{ width: "100%", borderSpacing: "0 8px" }}>
                        <thead>
                            <tr>
                                <th style={{ padding: "12px 20px", textAlign: "left" }}>Image</th>
                                <th style={{ padding: "12px 20px", textAlign: "left" }}>Title</th>
                                <th style={{ padding: "12px 20px", textAlign: "left" }}>Status</th>
                                <th style={{ padding: "12px 20px", textAlign: "left" }}>Inventory</th>
                                <th style={{ padding: "12px 20px", textAlign: "left" }}>Price</th>
                            </tr>
                        </thead>
                        <tbody>
                            {products.map((product) => (
                                <tr key={product.id}>
                                    <td style={{ padding: "8px 20px" }}>
                                        <img
                                            src={product.featuredImage?.url || "https://cdn.shopify.com/s/files/1/0533/2089/files/placeholder-images-image_large.png"}
                                            alt={product.featuredImage?.altText || product.title}
                                            style={{
                                                width: "50px",
                                                height: "50px",
                                                objectFit: "cover",
                                                borderRadius: "8px",
                                                border: "1px solid #e1e3e5",
                                                backgroundColor: "#f6f6f7"
                                            }}
                                        />
                                    </td>
                                    <td style={{ padding: "8px 20px" }}>
                                        <s-text fontWeight="semibold">{product.title}</s-text>
                                    </td>
                                    <td style={{ padding: "8px 20px" }}>
                                        <s-badge tone={product.status === "ACTIVE" ? "success" : "info"}>
                                            {product.status}
                                        </s-badge>
                                    </td>
                                    <td style={{ padding: "8px 20px" }}>
                                        <s-text tone="subdued">{product.totalInventory} in stock</s-text>
                                    </td>
                                    <td style={{ padding: "8px 20px" }}>
                                        <s-text fontWeight="semibold">
                                            ${product.variants.edges[0]?.node.price}
                                        </s-text>
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </s-data-table>
            </s-card>
        </s-page>
    );
}
