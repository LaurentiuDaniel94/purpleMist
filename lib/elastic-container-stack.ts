import * as cdk from "aws-cdk-lib";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as ecs from "aws-cdk-lib/aws-ecs";
import * as rds from "aws-cdk-lib/aws-rds";
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as servicediscovery from 'aws-cdk-lib/aws-servicediscovery';

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

    // Create roles
    const taskRole = new iam.Role(this, 'OpenWebUITaskRole', {
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
    });

    const executionRole = new iam.Role(this, 'OpenWebUIExecutionRole', {
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
    });

    // ECS Cluster
    const cluster = new ecs.Cluster(this, 'OpenWebUICluster', {
      vpc: props.vpc,
      containerInsights: true,
    });

    // Service Discovery Namespace
    const namespace = new servicediscovery.PrivateDnsNamespace(this, 'OpenWebUINamespace', {
      vpc: props.vpc,
      name: 'openwebui.local',
      description: 'Service discovery namespace for OpenWebUI services',
    });

    // Task Definition for OpenWebUI
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
        resources: [props.dbInstance.secret!.secretArn]
      })
    );

    // Container Definition for OpenWebUI
    const openWebUIContainer = openWebUITaskDef.addContainer('OpenWebUI', {
      image: ecs.ContainerImage.fromEcrRepository(props.repository, 'openwebui'),
      environment: {
        'WEBUI_SECRET_KEY': '123456',
        'DEBUG': 'true',
        'DATABASE_TYPE': 'postgres',
        'OLLAMA_BASE_URL': 'http://ollama.openwebui.local:11434', // Using service discovery for Ollama
      },
      secrets: {
        'DATABASE_URL': ecs.Secret.fromSecretsManager(props.dbInstance.secret!),
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

    // ECS Service for OpenWebUI
    const openWebUIService = new ecs.FargateService(this, 'OpenWebUIService', {
      cluster,
      taskDefinition: openWebUITaskDef,
      desiredCount: 1,
      securityGroups: [props.ecsSecurityGroup],
      vpcSubnets: {
        subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS
      },
      cloudMapOptions: {
        cloudMapNamespace: namespace,
        name: 'open-webui',
      },
    });

    // Task Definition for Ollama
    const ollamaTaskDef = new ecs.FargateTaskDefinition(this, 'OllamaTask', {
      memoryLimitMiB: 512,
      cpu: 256,
      taskRole: taskRole,
      executionRole: executionRole,
    });

    // Container Definition for Ollama
    const ollamaContainer = ollamaTaskDef.addContainer('Ollama', {
      image: ecs.ContainerImage.fromRegistry('ollama/ollama'), // Replace with the correct image name for Ollama
      logging: ecs.LogDrivers.awsLogs({
        streamPrefix: 'ollama',
        logRetention: logs.RetentionDays.ONE_WEEK,
      }),
    });

    ollamaContainer.addPortMappings({
      containerPort: 11434,
      protocol: ecs.Protocol.TCP
    });

    // ECS Service for Ollama
    const ollamaService = new ecs.FargateService(this, 'OllamaService', {
      cluster,
      taskDefinition: ollamaTaskDef,
      desiredCount: 1,
      securityGroups: [props.ecsSecurityGroup],
      vpcSubnets: {
        subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS
      },
      cloudMapOptions: {
        cloudMapNamespace: namespace,
        name: 'ollama',
      },
    });

    // Attach the OpenWebUI ECS Service to the ALB
    props.alb.listeners[0].addTargets('OpenWebUITarget', {
      port: 8080,
      targets: [openWebUIService],
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
