import { authenticate } from "../shopify.server";

export const loader = async ({ request }) => {
  await authenticate.admin(request);
  return null;
};

export default function Index() {
  return (
    <s-page heading="Welcome to Product Bulk Edit">
      <s-layout>
        <s-layout-section>
          <s-card>
            <s-block-stack gap="400">
              <s-text as="h1" variant="headingLg">
                Use the sidebar to access Import and Export features.
              </s-text>
            </s-block-stack>
          </s-card>
        </s-layout-section>
      </s-layout>
    </s-page>
  );
}
