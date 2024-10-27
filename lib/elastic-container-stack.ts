import * as cdk from "aws-cdk-lib";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as ecs from "aws-cdk-lib/aws-ecs";
import * as rds from "aws-cdk-lib/aws-rds";
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';

interface EcsStackProps extends cdk.StackProps {
  vpc: ec2.Vpc;
  dbInstance: rds.DatabaseInstance;
  ecsSecurityGroup: ec2.SecurityGroup;
  albSecurityGroup: ec2.SecurityGroup;
  repository: ecr.Repository;
  alb: elbv2.ApplicationLoadBalancer;
  targetGroup: elbv2.ApplicationTargetGroup;
}

export class EcsStack extends cdk.Stack {
  constructor(scope: cdk.App, id: string, props: EcsStackProps) {
    super(scope, id, props);

    // Retrieve the existing RDS secret values to construct the DATABASE_URL
    const dbSecret = props.dbInstance.secret!;
    const databaseUrl = `postgresql://${dbSecret.secretValueFromJson('username').unsafeUnwrap()}:${dbSecret.secretValueFromJson('password').unsafeUnwrap()}@${dbSecret.secretValueFromJson('host').unsafeUnwrap()}:${dbSecret.secretValueFromJson('port').unsafeUnwrap()}/${dbSecret.secretValueFromJson('dbname').unsafeUnwrap()}`;

    // Create a new secret in AWS Secrets Manager to store the DATABASE_URL
    const databaseUrlSecret = new secretsmanager.Secret(this, 'DatabaseUrlSecret', {
      secretName: 'openwebui-database-url',
      description: 'PostgreSQL connection string for the OpenWebUI application',
      secretStringValue: cdk.SecretValue.unsafePlainText(databaseUrl),
    });

    // Create roles
    const taskRole = new iam.Role(this, 'OpenWebUITaskRole', {
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
    });

    const executionRole = new iam.Role(this, 'OpenWebUIExecutionRole', {
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
    });

    // Task Definition
    const openWebUITaskDef = new ecs.FargateTaskDefinition(this, 'OpenWebUITask', {
      memoryLimitMiB: 512,
      cpu: 256,
      taskRole: taskRole,
      executionRole: executionRole,
      runtimePlatform: {
        cpuArchitecture: ecs.CpuArchitecture.ARM64,
        operatingSystemFamily: ecs.OperatingSystemFamily.LINUX,
      },
    });

    // Add permissions
    executionRole.addManagedPolicy(
      iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AmazonECSTaskExecutionRolePolicy')
    );

    executionRole.addToPrincipalPolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: [
          'secretsmanager:GetSecretValue',
          'kms:Decrypt'
        ],
        resources: [
          props.dbInstance.secret!.secretArn,
          databaseUrlSecret.secretArn,
        ]
      })
    );

    // Container Definition
    const openWebUIContainer = openWebUITaskDef.addContainer('OpenWebUI', {
      image: ecs.ContainerImage.fromEcrRepository(props.repository, 'openwebui'),
      environment: {
        'WEBUI_SECRET_KEY': '123456',
        'DEBUG': 'true',
        'DATABASE_TYPE': 'postgres',
      },
      secrets: {
        'DATABASE_URL': ecs.Secret.fromSecretsManager(databaseUrlSecret),
      },
      logging: ecs.LogDrivers.awsLogs({
        streamPrefix: 'openwebui',
        logRetention: logs.RetentionDays.ONE_WEEK,
      }),
    });

    openWebUIContainer.addPortMappings({
      containerPort: 8080,
      protocol: ecs.Protocol.TCP
    });

    // ECS Cluster
    const cluster = new ecs.Cluster(this, 'OpenWebUICluster', {
      vpc: props.vpc,
      containerInsights: true,
    });

    // ECS Service
    const service = new ecs.FargateService(this, 'OpenWebUIService', {
      cluster,
      taskDefinition: openWebUITaskDef,
      desiredCount: 1,
      securityGroups: [props.ecsSecurityGroup],
      vpcSubnets: {
        subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS
      }
    });

    props.alb.listeners[0].addTargets('OpenWebUITarget', {
      port: 8080,
      targets: [service],
      priority: 1,
      conditions: [
        elbv2.ListenerCondition.pathPatterns(['/openwebui*'])
      ]
    });

    // Output ALB DNS
    new cdk.CfnOutput(this, 'AlbDnsName', {
      value: props.alb.loadBalancerDnsName,
      description: 'ALB DNS Name',
      exportName: 'albDnsName'
    });
  }
}
