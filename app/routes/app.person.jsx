import { useState } from "react";
import { useActionData, useLoaderData, useSubmit, Form } from "react-router";
import {
  Page,
  Layout,
  Card,
  FormLayout,
  TextField,
  Button,
  BlockStack,
  Text,
  List,
  Box,
} from "@shopify/polaris";
import prisma from "../db.server";

export async function loader() {
  const people = await prisma.person.findMany({
    orderBy: { createdAt: "desc" },
  });
  return { people };
}

export async function action({ request }) {
  const formData = await request.formData();
  const firstName = formData.get("firstName");
  const lastName = formData.get("lastName");

  if (!firstName || !lastName) {
    return { error: "First name and last name are required" };
  }

  const person = await prisma.person.create({
    data: {
      firstName: String(firstName),
      lastName: String(lastName),
    },
  });

  return { person };
}

export default function PersonRoute() {
  const { people } = useLoaderData();
  const actionData = useActionData();
  const submit = useSubmit();

  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");

  const handleSubmit = () => {
    submit({ firstName, lastName }, { method: "post" });
    setFirstName("");
    setLastName("");
  };

  return (
    <Page title="Person Management">
      <Layout>
        <Layout.Section>
          <Card>
            <BlockStack gap="500">
              <Text as="h2" variant="headingMd">
                Add a New Person
              </Text>
              <Form method="post" onSubmit={handleSubmit}>
                <FormLayout>
                  <TextField
                    label="First Name"
                    name="firstName"
                    value={firstName}
                    onChange={setFirstName}
                    autoComplete="off"
                  />
                  <TextField
                    label="Last Name"
                    name="lastName"
                    value={lastName}
                    onChange={setLastName}
                    autoComplete="off"
                  />
                  <Button submit variant="primary">
                    Submit
                  </Button>
                </FormLayout>
              </Form>
              {actionData?.error && (
                <Text color="critical" as="p">
                  {actionData.error}
                </Text>
              )}
            </BlockStack>
          </Card>
        </Layout.Section>

        <Layout.Section>
          <Card>
            <BlockStack gap="200">
              <Text as="h2" variant="headingMd">
                People List
              </Text>
              {people.length === 0 ? (
                <Text as="p" tone="subdued">
                  No people added yet.
                </Text>
              ) : (
                <Box paddingBlockStart="200">
                  <List type="bullet">
                    {people.map((person) => (
                      <List.Item key={person.id}>
                        <Text as="span" fontWeight="bold">
                          {person.firstName} {person.lastName}
                        </Text>{" "}
                        <Text as="span" tone="subdued">
                          (Added: {new Date(person.createdAt).toLocaleDateString()})
                        </Text>
                      </List.Item>
                    ))}
                  </List>
                </Box>
              )}
            </BlockStack>
          </Card>
        </Layout.Section>
      </Layout>
    </Page>
  );
}

